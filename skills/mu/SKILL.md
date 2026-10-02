---
name: mu
description: Manage AI agents in terminal-multiplexer panes (tmux or herdr) — from a single off-the-cuff helper to a persistent crew coordinated through a built-in task graph. Use when the user asks to "create/spin up a subagent to X", "run X in the background", "do this in parallel", "use one subagent per X to do Y", "kick off a helper to watch/investigate/draft X", or to spawn, send work to, observe, or coordinate one or many agents — especially work you'll keep talking to, long-lived or background agents, or anything needing a dependency graph. For zero-ceremony helpers use the reserved `scratch` workstream; for one-shot "fire and get a result back" use the `mu_delegate` tool — its pane stays attachable.
---

# mu — Multi-agent orchestration

`mu` manages long-lived AI agents in multiplexer panes (tmux or
herdr), coordinated by a SQLite task DAG at
`<XDG_STATE_HOME or ~/.local/state>/mu/mu.db`.

**Trust `mu --help` / `mu <verb> --help` over this skill.** Verbs
not in `--help` do not exist.

## Output + JSON shapes

Default output is a card on stdout plus a `Next:` block. Read both.
Every verb takes `--json`: one stdout object; collections are
`{items, count}`; `mu sql --json` is bare rows; `mu log --tail` is
NDJSON. Errors are `{error,message,nextSteps,exitCode}` on stderr
(validation errors add `usage`). **`nextSteps` survives in JSON.**

## Vocabulary

- **workstream** — one **mux session** `mu-<name>` (tmux session or
  herdr workspace) and one DB partition.
- **agent** — named worker in a pane (you may be one).
- **mux** — tmux or herdr, one per invocation. `mu doctor` names it;
  `MU_MUX` forces it. `mu agent kick` is Linux-only on herdr.
- **control socket (ctl)** — how mu drives a pi agent: the mu pi
  extension (`mu link pi`) serves exact send, state, wait and abort
  inside pi's own TUI. `ctl missing|refused` means it does not answer.
- **task** — DAG node with mandatory `impact` (1–100) and
  `effort_days`. Shown as status/substate: `OPEN/todo|parked`,
  `IN_PROGRESS/active`, `CLOSED/done|rejected|wontfix|duplicate|superseded`.
  Any `CLOSED/*` satisfies `--blocked-by`.
- **claim / release** — atomic take/clear of `tasks.owner`.
- **note** — append-only task context; survives sessions.
- **track** — independent DAG subtree; spawn at most one agent per
  ready track.
- **workspace** — per-agent VCS copy under
  `<state-dir>/workspaces/<workstream>/<agent>/`.

## When to use mu

Use mu for persistent helpers, parallel work, dependencies, gated review, or
work that must survive context compaction. Stay in one context for tiny edits
or inspection.

### Off-the-cuff helpers (`scratch`)

The reserved `scratch` workstream holds helpers that need no task DAG; it
auto-creates on spawn. `mu_delegate` (installed by `mu link pi`) is its tool
form for one answer back; the CLI form is spawn + send + `mu agent wait --json`
(`lastText`).

- `mu agent wait <names...> --first` waits for busy → idle instead of a
  `sleep` loop; exit 0 met, 5 timeout, 6 pane died.
- For a watcher, persist last-seen state in a log ledger: write `mu log -w
  scratch --kind pr-state 'pr=1234 sha=abc ci=red'`, then read `mu log -w
  scratch --kind pr-state -n 1 --json`. Act only on change.
- One agent per independent unit; `--workspace` for any helper that may edit,
  build, or test the shared repo.

A helper stuck at `needs_input` right after spawn likely hit pi's
project trust prompt: add `--approve` to `MU_<CLI>_COMMAND`. Move off
`scratch` when work gains dependencies or review gates.

## Mental model

### Workstreams, DAGs, tracks

The DAG has one edge: `mu task block A --by B` means **B blocks A**.
Tracks sharing a prerequisite collapse into one, so two agents never
take the same dependency.

### Workspaces prevent trampling

If an agent may edit, build, or test while another is active in the same
repo, spawn with `--workspace`. Two builds in one checkout corrupt each
other; keep the main checkout for orchestration.

Workspaces auto-detect jj, sl, or git (else `cp -a`). `mu agent close`
frees one **only if clean** (no uncommitted changes, no commits since
fork); otherwise it fails with `WorkspacePreservedError`. Then use
`mu workspace free <agent>` or `--discard-workspace` (lossy).
Between waves, `mu workspace refresh <agent>` rebases onto main and
keeps LLM context. Claim and send warn at ≥10 commits behind
(`--strict-staleness` refuses).

### Remote agents

The PANE is local, the PROCESS is remote (`--command 'ssh <host> -t
"..."'`); `mu agent remote-env` forwards a pi agent's control socket.
**One orchestrator DB**: never run a second mu on the host. You create
the remote workspace yourself (`--workspace` is local-only).

**Read [REMOTE_WORKERS.md](REMOTE_WORKERS.md) before spawning your first
remote agent, and again before waiting on one.** Poll once per turn with
the claim's one-shot `Next:` command. On a session-capped host, route
long commands and polls through [mule](https://github.com/mu-crew/mule):
a refused bare ssh returns an empty sha that looks like progress.
**`mule` exit 3 is a HANDBACK** to the operator (hardware-key touch):
never retry or open `ssh -MNf` yourself.

### Agent names

Use roles with the smallest unused suffix: `worker-1`, `reviewer-1`,
`scout-1`, `auditor-1`, `planner-1`. No human names.

### Task note contract

End every delegated task with a note holding the applicable fields:

```text
FILES:    paths inspected/changed (line ranges if precise)
COMMANDS: commands run + exit codes
FINDINGS: what you observed
DECISION: what you chose, and why
NEXT:     follow-on tasks
VERIFIED: tests/checks/output
ODDITIES: weird things not acted on
```

Then close with grounding:
`mu task close <id> -w <ws> --evidence "tests pass: cargo test exit 0"`.

## Orchestrator loop

Every turn:

1. `mu state -w <ws>` — read agents, IN_PROGRESS, ready tasks,
   parallel tracks.
2. Spawn at most one agent per independent ready track.
3. **Claim before sending — even one-shot reviewers/scouts.**
   `mu task claim <id> -w <ws> --for <agent> --evidence "..."`.
   If no task exists, `mu task add` first (`--note 'REPRO: ...'` when
   the title is not enough). Ownership is durable and waitable; agent
   state is not.
4. Send each new task with `mu agent send <w> --fresh '...'` (new
   session + prompt in one step; refuses while busy): task id,
   files/notes to read, workspace path, validation command, scope
   guards, task note contract. Follow the `Next:` block; it picks
   `--fresh` vs `--steer` for you.
5. End with a loud final-action block:

   ```text
   ⚠️ FINAL ACTION
   git commit -am '...' THEN
   mu task close <id> -w <ws> --evidence '...'
   ```

6. `mu task wait ... --first --on-stall exit --json`.
7. Cherry-pick the closed worker's **new** commit(s), verify the MERGE
   (see below), return control. Do not barrier or loop in shell.
   Only `CLOSED/done` ships; other closes: read the reason note.
8. Repeat from `mu state`.

## Dispatch rules that prevent real failures

- **Pipeline; don't barrier.** Wait for one task, cherry-pick only its
  new commits, verify, return control. An umbrella wait hides progress;
  merging stale branches can restore reverted code.
- **Verify the merge, not the worker's rerun.** Only the combination
  with moved main is new; that found three breaks rerunning found none
  of. Run a remote merge gate on the host (see REMOTE_WORKERS.md).
- **Push only from a green gate.** Make `git push` the last line under
  `set -e`. Check the gate runs what it claims: an env-gated randomized
  test once passed with zero cases.
- **Dispatch from current main.** Reset the worker's worktree to main
  before each task.
- **Accept evidence, not close notes.** Re-run the key measurement from
  a clean checkout; close notes have claimed unpushed commits.
- **Freeze only what conflicts.** Give idle workers tasks that avoid
  shared files; a blanket freeze idled four of five workers for a day.
- **Fix done before a long run.** Put the completion criterion (checks,
  agreeing runs, allowed variance) in the task note first.
- **Split long proofs into independent units**, sharded and parallel,
  so one flake restarts only its unit.
- Bucket waves by file cluster, not severity; two agents editing one file
  conflict. Refresh workspaces between waves.
- Cross-workstream wait and claim use qualified refs; only task
  ownership crosses.
- For an idle worker, read the pane, then answer, retry, or release its
  task. `MU_IDLE_THRESHOLD_MS` defaults to 5m.
- **Never chain `/new` and a prompt as two sends to a pi agent:** the prompt
  can land mid-reset and vanish (it did, twice). `--fresh` does both inside pi.
- **Stop a worker:** `mu agent abort <w>` first for pi (exact, local or
  remote, keeps context, waits for idle; exit 5 = still busy; queued
  follow-ups return to the editor unsent). Then `mu agent kick` (pi
  unresponsive, or non-pi; local panes only), then `mu agent close`.
- Use `mu agent send`, not raw mux input. Single-quote prompts containing shell
  expansions, or use a quoted heredoc.

## CLI gotchas

- **`workstream teardown`** is dry-run without `--yes`. It writes
  TOMBSTONE ops, so `mu undo <group> --yes` reverses it; the log is the
  backup. `workstream list --torn-down` lists group ids to undo.
- **`task close --if-ready`** no-ops until every blocker is CLOSED; bare
  `task release` reopens IN_PROGRESS.
- **`task close --as rejected|wontfix --why ...`** (declined | valid, not worth it) unblocks dependents (listed in
  the output). To keep dependents waiting, `task park --why` instead: parked
  leaves `next`, and `claim` refuses it without `--force`. Park refuses
  IN_PROGRESS — `task release` first.
- **For waits use `task wait`, not `log --tail`.** `--kind` is the operator's
  log-ledger channel; `--intent` is what mu recorded.
- **`mu undo`** bare lists groups; `<group>` previews; `<group> --yes`
  emits inverse ops for that group only (redo = undo the undo). Exit 4
  if a later action changed the same fields (`--force` discards it).
  Rows only: killed panes and freed workspace dirs do not come back.
- **`mu rebuild <file>`** writes a new DB from the ops log, without
  agents or workspaces; re-spawn after the swap. Recovery is
  `mu rebuild`, not `mu db backup`.
- **`mu sql`** skips ambient sync.
- **Sync:** set `MU_SYNC_DIR` on each machine to a shared folder
  (Syncthing). Every command flushes and ingests ops, merged per field.
  mu never runs ssh or rsync; `mu sync` prints the line.
  `--repair <peer>` is always safe. **Never put `MU_DB_PATH` inside
  `MU_SYNC_DIR`**: it corrupts the DB. Agents, workspaces, and task
  ownership never travel.
- **`mu doctor --deep` DRIFT** (exit 5) is a capture bug: back up and
  report it. Do not rebuild; the live rows may hold work the log missed.
  The `disk` section is report-only: an orphan dir may hold the only copy
  of uncommitted work, so mu prints cleanup commands and runs none.

## `mu task wait`

Use `--first --on-stall exit`: `--first` populates `.firing`, and
`--on-stall exit` stops an unattended wait when a worker needs attention.
Exit 6 is a dead pane; exit 7 is an owner in `needs_input`. Read that
pane (`mu agent read <owner>`) and answer: the worker may be waiting on
you. Questions are cheaper than rework.

## Models and thinking effort

mu doesn't reason about models; pi does. Controls:

```bash
mu agent spawn r --command "pi --model opus:high"
export MU_PI_COMMAND="pi --model sonnet:medium"
mu agent spawn a --cli pi_big   # uses $MU_PI_BIG_COMMAND
```

Convention: `pi_mini` for probing, `pi` for build and refactor,
`pi_big` for design, review, and incidents. List models with
`pi --list-models [search]`.

## Reaper and agent state

If an agent pane dies, or `mu agent close` kills it mid-task, its
IN_PROGRESS tasks revert to OPEN with a `[reaper]` note. No manual
release after crashes.

pi agents report state through the control socket and need no murmur.
Other CLIs report through [murmur](https://github.com/mu-crew/murmur) on
tmux, or herdr on herdr. `unknown` means no state source; `mu doctor`
says why. Before a high-stakes decision, read the pane
(`mu agent read worker-1 -n 100`), `mu log -w <ws> --tail`, and
`mu task notes <id>`.

## In-pane worker loop

`$MU_AGENT_NAME` (injected at spawn) resolves identity; adopted panes
fall back to the pane title. In a worker pane, bare `mu task claim <id>`
works. In the unregistered orchestrator pane it errors; use `--self`,
`--for <worker>`, or `mu agent adopt <pane>`.

```bash
mu me
mu me next
mu task show <id>; mu task notes <id>
mu task claim <id> --evidence "starting; read notes"
mu task note <id> "FILES: ...\nDECISION: ...\nVERIFIED: ..."
mu task close <id> --evidence "tests pass: ..."  # LAST action
```

Skipping close makes the orchestrator's wait hang. Won't do it:
`close --as wontfix --why "..."`.

## Follow-on prompts

A plain `mu agent send` appends to prior context; use it to steer or
answer. Unrelated work to pi: `mu agent send worker-1 --fresh 'Claim
task_x...'`. claude-code/codex: send `/new` (codex: `/clear`), then the
prompt; a send it cannot confirm prints a `warning:` on stderr.

## Guardrails

Task ownership outranks agent state. Coordinate through task notes and
the activity log. Keep edges within one workstream and reserve the `mu_`
task-id prefix. Give workers bounded paths and commands.

## See also

- `mu --help`, `mu <verb> --help` — canonical CLI reference.
