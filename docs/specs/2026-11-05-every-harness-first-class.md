# Every harness first-class (mu-crew 4.x)

Status: draft 8, not approved. Written 2026-11-05 after four refutation
rounds and the local U0 spike ([U0 results](#u0-results-local-2026-11-05)). It replaces the "mu 5: harness-agnostic" drafts 1–3 (see
[History](#history)). Covers six repos: mu, murmur, museum, muzzle, the
crew dotfiles and org.

## Goal

Bring Claude Code, Codex, Muse Code and cursor-agent as close to pi's level
across mu-crew as their hooks allow, without degrading pi, and let one
crew mix them: an orchestrator of any harness runs workers of any harness,
locally and on remote hosts.

mu 4 orchestrates pi first. pi gets exact send, abort, wait, settle and the
CLOSE text from mu's control socket, delegates through `mu_delegate`,
activity in murmur, backups in museum, and command queueing in muzzle.
Every other agent CLI gets attention-only `murmur notify`, no send on tmux,
no backups, and partial muzzle support. People run all five as daily
harnesses, and the four non-pi CLIs ship their own subagents.

## Principles

- **Additive.** pi's integration stays as it is: the control socket,
  `mu_delegate`, steer, the settle nudge, murmur's in-process pi extension
  and footer, and museum's pi extension. No schema drops and no snapshot
  change. The one upgrade cost is a single murmur store reset, and the
  murmur CLI and pi package must upgrade together (D8).
- **One channel seam for pane agents.** mu's verbs on a pane agent go
  through one interface with three implementations: `ctl` (pi), `hooks`
  (the other four on tmux) and `mux` (today's herdr and Rex state). One
  contract suite runs against all three, so the less used paths cannot
  rot. Delegates, the spawn handshake, doctor and the remote socket
  plumbing stay on ctl directly (D4).
- **A narrow pi fallback.** `MU_PI_CHANNEL=hooks` runs a pi pane on the
  `hooks` channel. It covers a pi build that breaks murmur's store or a
  native module, as a Bun build of pi did for murmur and mu in November 2026. It does not cover a build that fails to load extensions at all.
  pi does not switch by default.
- **Ship in pieces.** Each repo releases its part as ordinary minor versions.

## Decisions

### D1. Five blessed harnesses

`claude` (Claude Code), `codex`, `muse` (Muse Code), `cursor-agent` and `pi`.
Muse Code uses Claude Code's hook event names and payload fields, but
installs hooks as plugins (D13).

Launch rules:

- Each harness's launcher stays in charge of its own sandbox, auth and model
  access. mu only starts it.
- Spawn the launcher on `PATH`, or the `MU_<HARNESS>_COMMAND` that names it.
  Never spawn a binary that a launcher wraps, an SDK-bundled CLI, or a
  JavaScript entry point through `node`.
- mu, murmur and museum set no base URL, provider, API key or proxy variable
  for any harness.
- The tmux server starts every agent (D10).

### D2. tmux is the design target

Every decision works on tmux, locally and over ssh. herdr and Rex keep their
backends: they deliver through their own `sendToPane` and supply state
through the `mux` channel.

### D3. Hook state: event files in a pane inbox, drained by readers

For claude, codex, muse and cursor-agent panes on tmux (and pi panes on the
fallback):

```text
harness hook ─► murmur hook <harness> ─► one event file in the pane's inbox
mu (continued, interrupted, remote state) ─► murmur hook mu ─► same
murmur status / pane / dash / export ─► drain the inbox into the store under the store lock ─► state + pane options
```

- **One event, one file.** `murmur hook <harness>` maps one payload on stdin
  to a canonical event ([vocabulary](#the-event-vocabulary)). It writes the
  event to `~/.local/state/murmur/inbox/tmp/` and renames it to
  `inbox/<pane key>/<ns timestamp>-<pid>.json`. A reader never sees a
  partial event, whatever its size or filesystem. The hook opens no
  database, takes no lock, calls no tmux and prints nothing. It exits 0 even
  when the write fails, so a hook never breaks a turn.
- **The process chain, not the environment, places an event.** Muse Code
  starts every non-managed hook, plugin or settings, with `env_clear()` and
  a fixed allowlist (per Muse's source), so its hooks see no
  `$TMUX`, `$TMUX_PANE` or `MU_*` (U0). Only managed hooks can request more
  variables, under a policy ceiling the launcher sets, and no user or
  plugin setting widens the list. So every hook reads the process table once
  (`ps -A -o pid=,ppid=,args=`) and walks parents from its own process up
  to the tmux server, which it recognises by argv, or by field 2 of `$TMUX`
  when that is set.
  - The pane root is the ancestor whose parent is the tmux server. The
    event carries the root pid and the server pid, plus `$TMUX` and
    `$TMUX_PANE` when present, as a cross-check.
  - Processes are matched to harnesses by argv, not by process name: pi can
    be `bun`, `pi` or `node`, and cursor-agent is `node`.
  - A run of adjacent processes of the same harness, with nothing else
    between them, is one harness: a launcher and the binary it starts.
    Every harness in U0 runs that way (`claude < claude`,
    `codex < codex.real`, `muse < muse.real`).
  - If the walk meets a second, separate harness before the server, the
    event is from a nested agent, and nothing is written. U0 saw every
    nested run as a second harness behind a shell.
  - If the walk never reaches a tmux server and finds no anchor with a
    remote key (D11), nothing is written. U0 saw
    claude's detached children, owned by launchd, fire `SessionEnd` with
    `$TMUX_PANE` still set.
  - Only the vocabulary's events are hooked, never `PreToolUse` or
    `PostToolUse`. A hook call cost 60–150 ms in U0, 316 ms at worst,
    `ps` included.
- **Agent identity comes from an anchor file.** mu starts every harness
  through a small wrapper that writes
  `~/.local/state/mu-next/anchors/<pid>.json` and then `exec`s the
  harness, so the pid stays the same. The file holds the agent name,
  workstream, cli, orchestrator flag, remote key and the process start time.
  A hook takes the first ancestor that has an anchor whose start time
  matches. Every U0 harness's hooks could read and write the crew state
  directories. Environment variables are used only as a fallback.
- **Last text travels in the event.** `turn_stopped` carries the last
  assistant text from the payload, capped at 64 KB:
  `last_assistant_message` for claude, codex and muse, and
  `afterAgentResponse.text` for cursor-agent. Nothing reads a transcript,
  in the hook or at drain time: U0 saw a hook-time read of claude's
  transcript return the previous turn's text. cursor-agent's text can
  arrive after its `stop`, so the drain attaches it to the turn with the
  same `generation_id`.
- **Keys.** The inbox directory is a hash of the server pid and the pane
  root pid. The drain, which may call tmux, maps the root pid to a pane
  with `list-panes -F '#{pane_pid} #{pane_id}'` on the server with that
  pid. It also maps the server to the store's `server_kind` and
  `server_value` the way the collector does, so a hook can never invent a
  second row. `reconcileLocal` still owns pane-id reuse. The drain deletes
  inbox directories whose server is gone.
- **Readers drain.** Under the store lock, a reader lists each inbox in name
  order, applies each event to the store, and deletes the file. Applied
  events are gone: nothing is retained or rotated, and a store rebuild loses
  only current state, which the next event restores.
- **The drain publishes pane options** (`@murmur_pane_state` and the others
  murmur's pi extension sets today) for every pane it changes. mu's send
  gate and ack read `murmur pane <key> --json`, which drains first.
- **pi keeps its pane.** murmur's `agents` table gains `source` (`pi` or
  `inbox`).
  - Before the drain claims an unclaimed pane, it checks whether a pi runs
    in that pane's process tree. It caches the answer per pane and
    `pane_pid`, and never claims for the inbox while a pi runs there.
  - pi's in-process claim replaces an `inbox`-sourced incumbent only when
    that incumbent's owner is dead, or is not an ancestor of the pi. This
    covers a stray inbox claim during pi's `/new` release window, or after
    a store reset. A pi nested under a live claude or codex is refused
    exactly as today: that refusal is the store's nested-agent defence.
  - The replacing path keeps the incumbent's attention rows. It never runs
    the delete that a same-pane replace runs today.
  - A row with source `pi` ignores inbox events.
- **Idle hosts.** With no attached client and no mu call nothing drains, and
  the inbox only costs disk. The hook stops writing for a pane past 10,000
  files, and `murmur doctor` reports it.
- **Ownership.** An event whose `session_id` differs from the claimed
  session is ignored unless it is `session_start`. The owner pid is the
  harness process found in the chain (`CLAUDE_PID` when set). The drain
  claims an unclaimed pane on the first event of any kind, so a hook
  installed mid-session recovers. Each row's drop rules (D6) run before
  any of this: codex's title-generation session, for example, would
  otherwise reset the pane on every first prompt.
- **State is advisory.** Any process under the user can write an event file.
  mu never closes a task on a state transition alone. A CLOSE block in a
  `turn_stopped` text is applied with the same trust as pi's ctl last text.

This amends murmur's ARCHITECTURE in four places:

1. The non-goal "no in-process integration for any harness other than pi" is
   replaced by "pi integrates in-process; other harnesses write events;
   readers own the store".
2. "CLOSED: no append, no ingest" reopens for exactly one path, the inbox.
   It is an ingest keyed on pane, not an event log: an applied event is
   deleted, and there is no replay or history.
3. For inbox events, the store's owner-pid gate applies a pid the hook
   recorded rather than the writing process's own. Trust model: any process
   under the user can write state, and state is advisory.
4. Single writer: a node's inbox holds events only about panes of its own
   tmux server. Remote workers use a separate area (D11).

None of this reaches the snapshot (D8). `notify` stays attention-only for
harnesses outside the blessed five.

### D4. The channel seam

`src/channels/` holds one `AgentChannel` interface for pane agents. It sits
at the existing wait seam (`WaitOptions.readAgents`/`watchAgent`) and adds
the delivery verbs:

- state reads and watches;
- send, interrupt, fresh, and `command` (`/compact`, `/reload`);
- `baseline`: incarnation and `runs` on `ctl`, `session_id` and `run_count`
  on `hooks`;
- `receipt`: msgId receipts (`mu agent check`) on `ctl`, the `run_count`
  ack on `hooks`;
- `fence`: ctl's `beforeWrite` write fence on `ctl`. `hooks` and `mux` have
  none; their at-most-once comes from never resending;
- last text.

Delivery on `hooks` goes through the pane's `MuxBackend`. tmux gains a paste
method; herdr and Rex keep `sendToPane`.

Staying on ctl directly, outside the interface: delegates (child pi
processes, not panes), the spawn handshake (`hello`, features, outdated
recovery), doctor, the lease carrier and remote socket plumbing,
`--no-ctl`, and the argv0 rule for ctl-speaking pi builds.

| Verb      | `ctl` (pi, unchanged) | `hooks`                                                                                                                                                                                   | `mux` (herdr, Rex, unchanged) |
| --------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| send      | exact, acknowledged   | clear the input line (the row's clear key), then paste through the backend; confirmed when `run_count` rises within `MU_SEND_ACK_MS` (default 10 s), otherwise `unknown` and never resent | `sendToPane`                  |
| steer     | mid-turn input        | refused with a typed error naming the channel                                                                                                                                             | refused                       |
| answer    | ctl                   | `mu agent answer <w> <choice>`: keys for a pending permission dialog; confirmed by the next event                                                                                         | keys                          |
| interrupt | exact abort           | Escape; codex and muse confirm with `Interrupt`, cursor-agent with an `aborted` stop; claude reads unconfirmed idle (`idle?`)                                                             | Escape                        |
| fresh     | ctl                   | the row's fresh command, sent like a prompt; confirmed by `session_start` with source `clear` or a new `session_id`                                                                       | sent like a prompt            |
| abort     | exact                 | interrupt, then `mu agent close`                                                                                                                                                          | same                          |
| settle    | exact                 | `turn_stopped` from the inbox                                                                                                                                                             | backend state                 |
| last text | ctl (64 KB)           | the `turn_stopped` event's text (64 KB)                                                                                                                                                   | none                          |

- **Clear before paste.** An interrupted claude puts its prompt back in the
  input box, and U0 saw the next paste merge into it and resubmit. `C-u`
  cleared the box on all four harnesses.
- The `hooks` send gate refuses `blocked` (use `answer`) and `running` (use
  `interrupt`, or `--force`). A `running` state with no event for
  `MU_STALE_MS` reads `unknown`, and a send needs `--force`. `idle?` is
  sendable: if the Escape only closed an overlay, the send gets no ack and
  reports `unknown`.
- mu records each agent's channel on its agents row at spawn (D8). Every
  verb reads the row, never the env. The contract suite asserts that no
  verb on a `hooks` agent falls back to ctl.
- Spawn presets set each harness's in-sandbox auto-approve mode, so a worker
  meets a permission dialog only for actions outside its sandbox (VERIFY the
  flags in U0).
- `--on-stall steer` and the `mu next` steer executor stay for `ctl` and
  fall back to reporting the stall on `hooks`.
- This reverses the 4.0 cut of tmux paste for the `hooks` channel. VISION
  §6 ("mu never falls back to pasting"), and the comments in `transport.ts`
  and `tmux.ts` that say the same, are amended in the unit that ships the
  paste (U8), not later.

### D5. Checks: native subagents for the four, recorded

- `mu_delegate`, delegate calls, waves and `mu next --refute` stay as they
  are. They need pi; with a pi build that reaches every model family, a pi
  delegate is already a cross-family checker.
- claude, codex, muse and cursor-agent orchestrators check with their native
  subagents, or with a cross-family `scratch` pane. Two new verbs record
  those checks, so a verdict is something mu recorded, not something the
  orchestrator says happened (VISION §9, §11):

  ```bash
  mu task check <id> -w <ws> --by <harness>/<model> --brief -      # prints check=<check id>; records the brief
  mu task verdict <id> -w <ws> --check <check id> -                # records VERDICT/EVIDENCE lines
  ```

- A check id is a ULID, so two synced machines never collide. `checks` is a
  portable table (id, task, by, brief, verdict, state) with capture columns,
  `KEY_COLUMNS` and fold code.
- `mu state` lists checks with no verdict next to open delegate calls. After
  a crash or compaction, a new orchestrator sees which checks were issued
  and which were lost.
- `--if-ready` on an umbrella: ready when its blockers are CLOSED and every
  check issued on them has a verdict.
- `MU_CHECK_PANES_MAX` (default 6) caps concurrent cross-family `scratch`
  panes. The recipes use a cross-family pane or a pi delegate for one
  refuter of each high or critical finding, and native subagents for the
  rest.

### D6. The harness table is data

`src/harnesses.ts`, one frozen table shared in shape by mu and murmur.
Values come from the installed binaries on 2026-11-04. `VERIFY` cells are
filled by U0.

| Field                  | claude                                                            | codex                                                                                                                                                           | cursor-agent                                                    | muse                                                                                                                                                                                                       | pi                                               |
| ---------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| default channel        | `hooks`                                                           | `hooks`                                                                                                                                                         | `hooks`                                                         | `hooks`                                                                                                                                                                                                    | `ctl`                                            |
| process chain          | `claude < claude` (launcher, binary)                              | `codex < codex.real` (launcher, binary)                                                                                                                         | `cursor-agent` (node, matched by argv)                          | `muse < muse.real`                                                                                                                                                                                         | `pi`                                             |
| hook config            | `~/.claude/settings.json` (or project `.claude/settings.json`)    | `~/.codex/hooks.json`; new or changed hooks need trust once                                                                                                     | `~/.cursor/hooks.json` or project `.cursor/hooks.json`          | the `hooks` key in `~/.config/muse/settings.json` or `<project>/.muse/hooks.json` (Muse format); a Claude-format plugin also works but cannot take `Interrupt` and sits behind `MUSE_EXPERIMENTAL_PLUGINS` | murmur's and mu's pi extensions                  |
| hook environment       | full                                                              | full                                                                                                                                                            | full                                                            | `env_clear()` plus a fixed allowlist (`HOME`, `PATH`, `USER`, `LOGNAME`, `TMPDIR`, `SHELL`, `LANG`, `TERM`, proxy): no `TMUX*`, no `MU_*`; only managed hooks can request more                             | n/a                                              |
| hooks sandboxed        | yes; crew state dirs writable                                     | no, once trusted                                                                                                                                                | no ("Run Everything")                                           | yes; crew state dirs writable                                                                                                                                                                              | n/a                                              |
| prompt_submitted       | `UserPromptSubmit`                                                | `UserPromptSubmit`                                                                                                                                              | `beforeSubmitPrompt`                                            | `UserPromptSubmit`                                                                                                                                                                                         | the input event (fallback)                       |
| permission_requested   | `PermissionRequest`, `Notification`                               | `PermissionRequest`                                                                                                                                             | none                                                            | `PermissionRequest` (seen under auto-review)                                                                                                                                                               | `ui_prompt_start`                                |
| turn_stopped           | `Stop`                                                            | `Stop`                                                                                                                                                          | `stop` (`status: completed`)                                    | `Stop`                                                                                                                                                                                                     | `agent_settled`                                  |
| turn_failed            | `StopFailure`                                                     | VERIFY                                                                                                                                                          | `stop` with `status: error`, not following an `aborted`         | VERIFY                                                                                                                                                                                                     | VERIFY                                           |
| interrupted            | none (mu writes)                                                  | `Interrupt` (with `turn_id`)                                                                                                                                    | `stop` with `status: aborted`                                   | `Interrupt` (with `turn_id`) in Muse-format hooks, declared `async: true`; rejected in Claude-format plugins                                                                                               | none                                             |
| session start / end    | `SessionStart` (source) / `SessionEnd` (reason)                   | same; `SessionStart` fires on the first prompt                                                                                                                  | `sessionStart` / `sessionEnd`                                   | same as claude; `SessionStart` fires on the first prompt                                                                                                                                                   | `session_start` / `session_shutdown`             |
| last text              | `Stop.last_assistant_message`                                     | `Stop.last_assistant_message`                                                                                                                                   | `afterAgentResponse.text`, may follow `stop`                    | `Stop.last_assistant_message`                                                                                                                                                                              | event payload                                    |
| events to drop         | chains that do not reach tmux (detached children)                 | `transcript_path: null` (title-generation session)                                                                                                              | the `error` `stop` after `aborted` for the same `generation_id` | `SubagentStop`                                                                                                                                                                                             | none                                             |
| never store            |                                                                   |                                                                                                                                                                 | `user_email`, `CURSOR_USER_EMAIL`, `CURSOR_ASKPASS_SECRET`      |                                                                                                                                                                                                            |                                                  |
| fresh command          | `/clear`                                                          | `/new`                                                                                                                                                          | `/new-chat`                                                     | `/new` (refused while a subagent runs)                                                                                                                                                                     | `/new`                                           |
| interrupt key          | Escape                                                            | Escape                                                                                                                                                          | Escape                                                          | Escape                                                                                                                                                                                                     | Escape                                           |
| clear-input key        | `C-u`                                                             | `C-u`                                                                                                                                                           | `C-u`                                                           | `C-u`                                                                                                                                                                                                      | n/a                                              |
| can block on stop      | yes; the reason reaches the model                                 | yes; the reason reaches the model                                                                                                                               | yes (`followup_message`)                                        | no: a block re-checks the answer and the reason is not followed                                                                                                                                            | yes (`agent_before_settle`)                      |
| sandbox marker env     | `CLAUDECODE`, `CLAUDE_PID`                                        | `CODEX_SESSION_ID`, `CODEX_THREAD_ID`                                                                                                                           | `CURSOR_AGENT`, `CURSOR_CONVERSATION_ID`                        | `MUSE_SESSION_ID`, `MUSE_THREAD_ID` (in hooks)                                                                                                                                                             | none                                             |
| sessions (museum, D12) | `~/.claude/projects/<slug>/<uuid>.jsonl` and `<uuid>/subagents/*` | `~/.codex/sessions/YYYY/MM/DD/*.jsonl`                                                                                                                          | SQLite chats; not backed up                                     | VERIFY                                                                                                                                                                                                     | `~/.pi/agent/sessions/**/*.jsonl`                |
| initial prompt         | none: launched without a prompt (D17)                             | none (D17)                                                                                                                                                      | none (D17)                                                      | none (D17)                                                                                                                                                                                                 | ctl send (unchanged)                             |
| trust flag             | none: a worktree of a trusted repo inherits trust                 | `-c 'projects."<realpath>".trust_level="trusted"'` for mu-created worktrees: folder trust is per exact path; hook trust is per hook definition and carries over | `--trust`                                                       | `--trust-workspace` (not saved)                                                                                                                                                                            | none                                             |
| model flag             | `--model`                                                         | `-m` / `--model`                                                                                                                                                | `--model`                                                       | `--model`                                                                                                                                                                                                  | `--model`                                        |
| auto-approve flag      | `--permission-mode acceptEdits` or `auto`                         | `-s workspace-write -a never`                                                                                                                                   | `--sandbox`; `--force` only by explicit opt-in                  | `--approval-mode never`                                                                                                                                                                                    | none (`--approve` is folder trust, not approval) |
| skill location         | `~/.claude/skills/`                                               | VERIFY, never `~/.agents/skills/`                                                                                                                               | VERIFY, never `~/.agents/skills/`                               | `muse skills` or a plugin                                                                                                                                                                                  | pi package (unchanged)                           |

cursor-agent has no permission hook. Its `blocked` state is unknown, and mu
says so. claude subagents fire `SubagentStop`, not `Stop`, so they reach no
hooked event. In U0, permission dialogs were rare everywhere: auto modes
and sandboxes refused or approved an out-of-repo write without asking, so
`blocked` is the exception, and a refusal reads as an ordinary turn.

### D7. Keep-driving and the close nudge for the four: a mu-owned Stop hook

pi keeps its settle nudge. For the other four, mu installs one Stop hook
entry, `mu hook stop` (D13), with the harness's longest allowed hook timeout
(VERIFY in U0).

- **Guards.** The hook acts only for a pane agent mu started: it walks its
  process chain to an anchor (D3) whose cli matches the hook's harness,
  with no other harness in between, and whose agent is not remote. The
  orchestrator flag also comes from the anchor. Environment variables are
  a fallback only, because Muse Code strips them from plugin hooks. These
  rules mirror pi's nudge, which already skips a nested pi and
  `MU_REMOTE=1`. A checker that a managed agent starts never consumes its
  parent's events or gets its parent's close nudge.
- **Muse Code cannot keep driving.** In U0 a Muse Stop block made it
  re-check its answer without following the reason, so the resume text
  never reaches the model. Muse orchestrators and workers use the SKILL.md
  rule, and `mu hook stop` is not installed for Muse.
- **Orchestrator pane** (`MU_ORCHESTRATOR=1`):
  - A live process already waits as this caller, such as a background
    `mu wait`: allow the stop. That wait wakes the agent when it returns.
  - Otherwise run a consuming `mu wait --first --timeout <T> --as <caller>`,
    with `T` 10 s below the hook timeout, the same wait pi's settle nudge
    runs.
  - Events arrive: block, with the `resume` text listing them. They are
    consumed, because the block text hands them to the model.
  - It times out while work is owed: block, with "workers are still
    running; run `mu wait` in the background".
  - Nothing is owed: allow the stop.
- **Worker pane** that still owns an `IN_PROGRESS` task: block once per
  session, with "close your task or park it".
- Every block writes `continued` through `murmur hook mu`, because a resumed
  turn fires no `prompt_submitted`.
- The machine-local counter `keep_driving(session_id, empty_blocks)` caps
  consecutive timeout blocks at `MU_KEEP_DRIVING_MAX` (default 20). A block
  that delivers events, and every `prompt_submitted`, resets it.
- **Access.** The hook writes mu's DB and reads tmux exactly as the
  orchestrator's own `mu wait` does. It needs no access the orchestrator
  lacks, provided hooks run with at least the agent's own shell access
  (VERIFY in U0). A harness whose hooks have less, or that cannot block,
  falls back to the SKILL.md keep-driving rule.

### D8. Schemas grow, never break

**murmur.** The local store adds `run_count`, `session_id`, `harness`,
`source` and `last_text` (64 KB). `pi_session` stays.

- **Store upgrade.** Any store column change bumps `SCHEMA_USER_VERSION`.
  The newer build resets the store once, dropping agent and attention rows,
  which the next events restore. An older build refuses the newer store and
  goes silent, by design: the pi extension and the CLI are separate
  installs.
- **Release rule.** So the murmur CLI and murmur's pi package ship and
  upgrade together. `devbox update` and the release notes do both at once.
  The same release adds a "compatible since" stamp next to the schema
  version, so a later build that only adds columns stops forcing a reset.
- **The snapshot does not change.** Its reader rejects unknown keys and any
  version but its own, and `toAgent` picks fields explicitly, so the new
  columns never reach it. Nothing here reads the new fields from a peer:
  remote state goes through `murmur pane --remote` (D11).

**mu.** mu has no migration ladder: `openDb` accepts only schema 13 and
completes a v13 file in place through `upgradeSchema`. So everything here is
an `upgradeSchema` addition at schema 13, not a version bump:

- the portable `checks` table (D5);
- the machine-local `keep_driving` table (D7);
- a machine-local `channel` column on agents (D4);
- a capability column on `host_profiles` (D17).

Nothing is dropped. What peers see:

- `CAPTURE_VERSION` is a local trigger revision and never reaches a peer.
  `SEGMENT_FORMAT_VERSION` stays unchanged: a segment line names its entity
  as a free string, and an older build records an unknown entity's ops
  without projecting them.
- So a 4.3 peer reports an `--if-ready` umbrella as ready without its
  verdicts. The release notes say so.
- In the same `upgradeSchema` transaction that creates `checks`, mu
  re-applies every stored op with entity `check` through `applyOp`, which
  nests as a savepoint. A peer that synced checks before upgrading sees
  them. A fold test covers verdicts that arrive out of hlc order.

### D9. Caller identity is explicit

- `mu orchestrate -w <ws> --cli <harness>` starts an orchestrator of any
  harness as a managed pane. It sets `MU_MANAGED_AGENT=1`, `MU_WORKSTREAM`,
  `MU_AGENT_NAME` and `MU_AGENT_CLI`, which `currentCallers` and
  `spawnerFromEnv` need, plus the new `MU_ORCHESTRATOR=1`.
- **`mu_delegate` stays visible to orchestrators.** Its gate
  (`extension/delegate.ts`) changes from "hidden under `MU_MANAGED_AGENT`" to
  "hidden under `MU_MANAGED_AGENT` unless `MU_ORCHESTRATOR=1`", and VISION's
  key constraint 3 says the same. `MU_ORCHESTRATOR` never reaches a helper:
  `delegate-process` deletes it from the child's env, and it joins
  `LOCAL_ONLY_ENV`, so remote workers never inherit it either. Workers and
  delegates still cannot spawn helpers.
- **A managed pi orchestrator keeps its delegates in view.** Delegate calls
  are owned by `pi:<session>`, but `spawnerFromEnv` prefers the managed
  name. `mu state` and `mu next` therefore read caller-owned delegates and
  checks through `currentCallers()`, the union of both identities.
- **Worker-only behaviour stays worker-only.** The close nudge and
  `injectedWorkstream` (implicit `-w`) apply to managed agents that are not
  orchestrators. A pi orchestrator started by `mu orchestrate` behaves like
  a hand-started one, plus keep-driving and an explicit identity.
- An orchestrator a human starts by hand outside `mu orchestrate` gets no
  keep-driving on the four. pi's `PI_SESSION_ID` identity stays.
- Outside a managed pane, a verb that needs a caller takes `--as <name>`.
  `--as` is refused while another live process waits as that caller.
- mu never guesses a caller from `$TMUX_PANE` or `$USER`.

### D10. The tmux server is born outside every sandbox

A tmux server's children inherit the server's sandbox, not the client's.
Verified 2026-11-04: from a sandboxed Claude Code session,
`tmux new-session -d` on the user's running server started a pane that
wrote a file the session's sandbox refused. A launcher that applies its own
sandbox fails when started inside another sandbox.

- mu never starts a tmux server it will spawn agents into while it runs
  inside an agent. The guard sits on `ensureSession`'s no-server path
  (`src/mux/tmux.ts`). The caller is an agent when a row's marker env or
  `MU_MANAGED_AGENT` is set. The error tells the human to start tmux from a
  terminal.
- Tests that start private servers for fake harnesses are unaffected.
  `test/_setup.ts` also clears every marker env.
- U0 tests the socket connect from inside each harness's sandbox. A harness
  whose sandbox refuses the socket can be a worker but not an orchestrator.

### D11. Remote workers on the `hooks` channel

pi's remote workers keep the control socket and the
`{local_sock}`/`{remote_sock}` templates. For the other four:

- Remote spawn passes `MU_REMOTE_KEY=<origin host>/<origin pane key>`,
  `MU_MANAGED_AGENT`, `MU_AGENT_CLI`, `MU_AGENT_NAME` and `MU_WORKSTREAM`
  through the host profile's `{env}`.
- The remote wrapper writes the same anchor (D3) with the remote key, so a
  hook finds the key without the environment.
- A remote worker under plain ssh has no tmux in its chain, which ends at
  `sshd` (U0). Its anchor's remote key is what routes its events.
- With a remote key, the remote hook writes to
  `~/.local/state/murmur/remote/<key>/`, not the inbox. The remote node's
  own drain never reads it, its store never holds the row, and its snapshot
  never exports it.
- mu reads remote state on demand with `murmur pane --remote <key> --json`
  through the profile's `exec` template (`mule exec --host H -- sh -c
{cmd}` on lease hosts). That drains the remote area into
  `remote/<key>.json`, replaced by rename. mu then writes what it read into
  the origin host's inbox for the ssh pane through `murmur hook mu`, so only
  the origin node has a row for that pane.
- Reads happen on `mu agent wait`, `collect` and the send gate, never in an
  ack poll loop: a lease host's `exec` costs several serialized ssh round
  trips under the ticket lock.
- A remote send returns `sent`, and the next read confirms it. A remote
  interrupt writes `interrupted` through the same `exec` path.
  `mu agent collect` reads the remote last text for the CLOSE block.

### D12. museum backs up every blessed harness

pi's backup path stays as it is: the extension's sync trigger, session-end
flush, footer and in-transcript `museum` record. For the others:

- **Metadata from the transcripts and one start record.** claude records
  `cwd` and `gitBranch` on every line. codex records the cwd, git branch,
  commit and repository URL in `session_meta`. Agent, role and workstream
  exist only in mu's anchor (D3) or the agent's env, so a
  `museum hook <harness>` entry on `SessionStart` reads them from there and
  writes them, with the session id and the cwd's git state,
  to `~/.local/state/museum/meta/<harness>/<session id>.json`. museum never
  writes into another harness's transcript.
- **Sources** come from the D6 `sessions` row, walked recursively. claude
  includes `<uuid>/subagents/*.jsonl`. claude deletes old transcripts after
  `cleanupPeriodDays`, so sync never deletes from the store. A codex rollout
  can grow months after its date directory, so change detection stats the
  whole tree, and codex's project folder comes from
  `session_meta.payload.cwd`.
- **cursor-agent is not backed up.** Its chats are live SQLite databases
  under a hash of the cwd: unsafe to copy and not greppable. `museum status`
  says so. U0 looks for an export command.
- **claude and codex append only** (claude VERIFY in U0), so they keep
  `--append-verify`.
- **Privacy and size filter.** claude transcripts carry `api-request` and
  `api-request-blob` records, `file-history-snapshot`, and full tool output
  in `toolUseResult`. codex carries `encrypted_content` and repeated
  `replacement_history` copies; one session is 212 MB. museum keeps a
  filtered copy of each source, extended from a byte cursor, and syncs that.
  The filter drops those records and caps a tool result at 64 KB. A source
  that shrank is filtered again from scratch.
- **Trigger from outside every sandbox.** Harness hooks cannot run rsync or
  ssh inside a sandbox, so:
  - `museum tick` is a shell script that exits unless a 10-minute stamp has
    expired or a flush stamp exists, cheap enough for a tmux `status-right`
    `#()`, which the tmux server runs unsandboxed. Only then does it start
    the sync, detached.
  - A `SessionEnd` hook only touches the flush stamp, so a final turn is not
    left 10 minutes late.
  - A launchd or systemd timer runs `museum tick` every 5 minutes, for a
    devserver with no attached client before it is reclaimed.
  - The sync finds rsync through the configured `rsync_path`, not the
    caller's `PATH`.
- **Store layout:** new harnesses go to
  `<store>/<machine>/<harness>/<project folder>/<file>`. pi's existing
  layout is not moved and reads as harness `pi`, including the legacy
  root-level files that search cannot see today.
- **Search, `stats` and `calls`:**
  - Discovery walks recursively and parses the path by depth.
  - Dates come from each file's first record, cached in the index.
  - One normaliser per format (pi, claude, codex) maps to a common stream:
    user, assistant, tool call, tool result, timestamps, model. Messages and
    calls are counted after merging: claude lines by `message.id`, codex
    records by `call_id`.
  - `find` searches the normalised text, not pi's serialisation.
  - muse's format is VERIFY in U0. Until it has a normaliser it syncs and
    stays greppable.
  - Paths are passed after `--`, because claude slugs start with `-`.

### D13. Hook installation is shared and merge-safe

mu (`mu hook stop`), murmur (`murmur hook`), museum (`museum hook`) and
muzzle (`muzzle hook`) write entries into the same config files
(`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`).

- Each tool owns only entries whose command starts with its own name. Its
  `init` adds or updates those entries and never touches others.
- Its `doctor` verifies its own entries and reports drift.
- Muse Code: each tool's `init` writes Muse-format entries under the
  `hooks` key of `~/.config/muse/settings.json`, merge-safe like the
  others. That is the only route to Muse's `Interrupt` event: Claude-format
  plugins cannot subscribe to it, need `muse plugins approve`, and sit
  behind the experimental plugin gate. codex likewise asks the user to trust
  new or changed hooks once.
- Availability is per harness: `murmurAvailable(cli)` checks the pi
  extension for pi and the hook entries for the others, so a missing pi
  extension still warns on a machine that has claude hooks.

### D14. muzzle queues heavy commands for every blessed harness

muzzle already rewrites shell calls for Claude Code and Codex
(`muzzle hook claude|codex` on `PreToolUse`) and for pi (its extension).

- **cursor-agent.** Its `beforeShellExecution` hook can allow or deny, never
  rewrite. `muzzle hook cursor` denies a matching command with the exact
  `muzzle run --rule <r> -- <command>` line as the reason, and passes any
  command that already starts with `muzzle run`.
- **muse.** `muzzle hook claude` serves Muse Code when its `PreToolUse`
  payload names the shell tool the way Claude does (VERIFY in U0).
  Otherwise the row gets a tool-name mapping.
- **Install.** muzzle joins D13.
- **Sandbox.** `muzzle run` executes inside the harness sandbox, so it must
  take its slot locks and append its run log there. U0 tests it. A harness
  whose sandbox refuses them runs unqueued, and `muzzle doctor` says so.
- **Queued is not stalled.** A worker waiting for slots fires no hook
  events. mu reads `muzzle status --json` and treats a queued holder pid
  under the worker's pane as waiting.
- **Evidence.** muzzle's benchmark importer reads `museum-search calls
--json`, so D12's normalisers give it baselines from every harness.

### D15. The pi fallback

- `mu agent spawn --cli pi` with `MU_PI_CHANNEL=hooks` set records channel
  `hooks` on the agents row (D4). Verbs follow the row.
- murmur's pi extension, told the same through the env, skips the store
  entirely and writes only inbox files. The store is already loaded lazily,
  so this mode loads no native module. It never claims in-process, so the
  pane has one writer and the `source` rule (D3) does not apply.
- mu's pi extension still serves its control socket, because spawn sets
  `MU_CTL_SOCK`. On a `hooks` pi, ctl serves only the spawn handshake,
  delegates and doctor. Every verb uses `hooks`, as the contract suite
  asserts.
- Keep-driving on the fallback is mu's settle nudge while mu's extension
  loads, else the SKILL.md rule.

### D16. The crew dotfiles and org follow

- **crew dotfiles.** `codex/config.toml` (`notify = ["murmur", "notify", …]`)
  and `cursor/hooks.json` (a `stop` hook calling `murmur notify`) are the
  attention-only wiring this plan replaces. They become documented examples
  of what `murmur init`, `mu init` and `muzzle init` write, with Claude Code
  and Muse Code entries added. `opencode` keeps `notify`. The tmux formats
  may show the pane's `harness` from murmur's store.
- **org.** `STANCE.md` says "Built on tmux and pi", "pi is the agent", and
  "Every feature ships on tmux and pi first, and that path is the one we
  test"; its "Beyond tmux and pi" table lists Codex and Cursor as attention
  only. `profile/README.md` says "Run a crew of pi agents in tmux", backs up
  "every pi session", and installs with `pi install` only. Both say instead:
  tmux is the runtime; pi has the exact channel; the five blessed harnesses
  are first-class and tested through the contract suite and evals. The
  "Beyond" table keeps only the limits that remain, from "What the `hooks`
  channel still lacks" below.

### D17. Mixed crews

Any orchestrator runs workers of any blessed harness, side by side, on the
local tmux server and on remote hosts. A claude orchestrator can have a
local codex worker, a local pi worker, a remote claude worker and a remote
pi worker at once.

- **Per worker, not per crew.** Each worker's harness and channel are on
  its agents row (D4), so every verb picks the right channel per worker. pi
  workers keep ctl, locally and remotely.
- **Harness from key.** cli keys are free-form (`pi-meta`, `claude-big`). A
  key maps to a harness row by the basename of the resolved command's
  argv0, falling back to the key's prefix before `-` or `_`. On `--host`,
  `isCommandGate` treats a command that maps to a harness row as an agent,
  not a command gate, so worktrees and lease profiles work for it.
- **Spawn keeps mu's journal.** The task spawn's journaled order stays:
  reserve, pane, claim, `sending`, write, sent. Every rule about which
  failures are unsent (rolled back) and which are `unknown` (kept, never
  resent) stays. A `hooks` worker is launched with no prompt, so nothing
  reaches it before the claim, the `sending` journal and the executor's
  send guard.
- **The write on `hooks`.**
  - Wait for `session_start` in the inbox, the `hooks` counterpart of pi's
    ctl `hello`.
  - Write the brief to `.mu/brief-<agent>-<attempt key>.md`, so two workers
    in one cwd never share a file. The bytes are exactly those the receipt
    stores for replay.
  - Write `.mu/.gitignore` containing `*` next to it, so the file never
    makes a worktree dirty and `git add -A` never commits it. Nothing in
    the user's repo config changes.
  - Paste a one-line pointer telling the worker to read and follow that
    file, and confirm it by `run_count` (D4).
  - Only the pointer goes through the paste, which keeps the dialog race to
    one short line.
- **Readiness and recovery.** The existing `unknown` receipt and outcome are
  reused. `reconcile` gains a `hooks` branch: it reads the inbox for the
  worker's `session_id` and a `run_count` above the baseline, promotes the
  receipt to `sent`, and pins the brief note, as a ctl receipt is promoted
  today. Remote spawns are promoted on the next read (D11).
  `MU_SPAWN_ACK_MS` is parsed like `MU_SPAWN_CTL_MS`.
- **Trust.** A worker whose harness distrusts the new worktree or its hooks
  fires no events, and its spawn ends `unknown`. Spawn presets pass the
  row's trust flag for mu-created worktrees only (D6), and U0 verifies each
  harness's behaviour in a fresh mu worktree.
- **Remote briefs.** A remote spawn writes the brief file through the
  profile's `exec` template as one argument. Exec templates have no stdin
  path, so a brief over 96 KB fails with a typed error. Linux caps one
  argument at 128 KiB before quoting.
- **Model and approvals per worker.** `--model` maps through the row's model
  flag, and spawn presets add the row's auto-approve flag (D6). pi gets
  none: its `--approve` is folder trust. The recipe `models` keeps its
  cross-family rule for checkers.
- **The auto executor on `hooks`.** `mu task auto --cli <harness>` already
  records a cli per task.
  - On `hooks`, `session_id` stands in for pi's incarnation in the retry
    target, and the `run_count` at readiness goes into `receipt.runs`.
  - A retry after `turn_failed` rewrites the brief file with the stored
    bytes and pastes the one-line pointer again.
  - Charging is unchanged.
  - Only harnesses whose `turn_failed` row is verified get the in-place
    retry. The others park as `needs_human`, as an unknown outcome does
    today.
- **Host capabilities.** `mu host check` probes the literal command a spawn
  would run, through the profile's own shell mode. Lease jobs run `sh -c`
  without rc files, so `MU_<HARNESS>_COMMAND` in a shell rc proves nothing
  there. It also checks that the harness's murmur and mu hook entries are
  installed.
  - The result and its probe time go in a new `host_profiles` column (D8).
  - The pi and pi-extension steps become conditional on the host
    advertising pi, so a claude-only host passes.
  - A spawn for a harness the host lacks fails with a typed error naming
    host and harness.
  - Logging each harness in on each host stays the user's job.
- **`mu init`** is new. It installs mu's hook entries (D13) and mu's worker
  skill where each harness reads skills (D6). It never writes into a
  directory pi also reads (`~/.agents/skills/`), where a second `mu` skill
  would collide with the pi package's, and it skips any existing entry it
  did not write.
- **One view.** `mu agent list` and `mu state` show each worker's harness
  and channel. murmur shows the harness per pane.

## The event vocabulary

| Event                    | Effect on murmur state                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `session_start` (source) | claim the pane if unclaimed; `startup`/`clear`: new `session_id`, `run_count` 0, idle; `resume`: idle; `compact`: no state change |
| `prompt_submitted`       | running; `run_count += 1`; clear `done`; reset the D7 counter                                                                     |
| `continued`              | running (written by `mu hook stop` on a block)                                                                                    |
| `permission_requested`   | attention `blocked`, message is the tool name                                                                                     |
| `interrupted`            | from the harness: idle. From mu: `idle?`, which the next harness event replaces                                                   |
| `turn_stopped`           | idle; `last_text`; `done` through `settledState` (skipped while focused or crew)                                                  |
| `turn_failed`            | attention `error`                                                                                                                 |
| `session_end` (reason)   | `clear`: keep the claim; otherwise release                                                                                        |

`blocked` clears on the next event or on `mu agent answer`. After a human
approves in the pane, the state stays `blocked` until the next event. U0
measures how often that misleads a wait. `PreToolUse`/`PostToolUse` are not
hooked for state, because they fire on every tool call.

## What the `hooks` channel still lacks against pi

- Mid-turn steering.
- An exact send acknowledgement. `run_count` confirmation is close.
- An exact interrupt acknowledgement on claude (codex, muse and cursor-agent report one).
- A write fence. At-most-once rests on never resending.
- A blocked state that clears the moment a human approves in the pane.
- Telling a long tool call from a hung one.
- Synchronous remote acks.
- `mu_delegate` children. The four use native subagents, recorded by D5.
- cursor-agent's permission state and session backups.

## Scope by repo

### murmur

- Add: the inbox, `drainInbox()`, pane-option publishing and the nested
  rule; `murmur hook <harness>` and `murmur hook mu`; `murmur pane <key>
--json` and `--remote`; the store additions and `source` (D3, D8);
  merge-safe `init`/`doctor` (D13); the four ARCHITECTURE amendments; the
  pi extension's store-free fallback mode (D15).
- Change: pi's claim replaces an `inbox`-sourced incumbent (D3).
- Keep: the pi extension, footer and pi CLI; `murmur notify`; the snapshot.

### mu

- Add: the harness table; the channel seam with `ctl`, `hooks` and `mux`;
  the contract suite; `mu orchestrate`, `--as`, `MU_ORCHESTRATOR` and
  `MU_AGENT_CLI`; the D10 guard; the `hooks` verbs and tmux's paste method;
  `mu hook stop` and `keep_driving`; `mu task check`/`verdict`, `checks`
  and the re-fold; the D11 remote path; the agents `channel` column;
  `murmurAvailable(cli)`; trust-dialog handling for codex and cursor-agent
  worktrees (VERIFY); D17's brief file, `hooks` spawn readiness, per-row
  model and approval flags, the auto executor's `hooks` path, host
  harness capabilities, and the per-harness worker skill in `mu init`.
- Change: the `mu_delegate` gate lets orchestrators through (D9).
- Keep: `extension/`, `src/ctl/`, delegates, steer, `next --refute`, and
  every pi path.
- Rewrite:
  - VISION §6 and the paste comments in `transport.ts` and `tmux.ts`, with
    the paste unit (U8); VISION key constraint 3 with the gate change (U7).
  - SKILL.md: a capability section per channel; "Checks are calls" covers
    native subagents with recorded verbs as well as delegates.
  - Recipes: `tasks-or-calls`, `findings`, `adversarial-review`,
    `course-correct`, `test-health` gain the native-subagent path;
    `orchestrator-loop` and `worker` gain the `hooks` caveats; `models`
    gains per-harness model flags; `remote-workers` gains D11.
  - Prompts: ship as per-harness skills or commands where the harness
    supports them.
  - Guides: `other-agent-clis.md` becomes the per-harness setup guide;
    `remote.md` and `stop-a-worker.md` gain the `hooks` path.
  - README, `docs/reference/surface-contract.md`, CHANGELOG.

### museum

Everything in D12. Rename "pi coding-agent sessions" in the README and skill
to "agent sessions", and make the `museum` skill installable for each
harness.

### muzzle

Everything in D14: `muzzle hook cursor`, the Muse Code mapping, merge-safe
`init`/`doctor`, the sandbox check, and a `muzzle status --json` field that
names each holder's pid and pane. Hook snippets in `docs/harnesses/` gain
cursor-agent and Muse Code.

### crew dotfiles and org

Everything in D16.

### Not in scope

mule needs no change; U0 checks that `mule exec` carries the D11 read. The
Rex backend branch should merge or park before U5, because U5 and U6 move
the paths it touches.

## U0 results (local, 2026-11-05)

The local half of U0 ran on macOS with Claude Code 2.1.310, Codex 0.164.0,
cursor-agent 2026.10.22 and Muse Code 1.4.15. Each ran in a pane of the
user's tmux server, through the kit in `spike/u0/`: a logging hook on every
event, plus a driver that pastes test prompts. The D6 table holds the
per-harness facts. In summary:

- Hooks of all four could write all four crew state directories and reach
  tmux. Only Muse strips the hook environment.
- A 3 KB multi-line paste arrived intact in all four.
- A Stop block continued the turn in all four. The reason reached the model
  in claude, codex and cursor-agent, not in Muse.
- Interrupts: codex fires `Interrupt`, and so does Muse from Muse-format
  hooks (asynchronous handlers only); cursor-agent fires a `stop` with
  `status: aborted`; claude fires nothing.
- Every nested run (`claude -p`, `codex exec`, `cursor-agent -p`,
  `muse exec`) appeared as a second harness behind a shell in the chain.
- codex runs a hidden title-generation session that fires the full event
  set with `transcript_path: null`.

Fresh worktrees and a remote host (dev0, Linux):

- In a new git worktree of a trusted repo, claude needs nothing. codex asks
  for folder trust on every new path, and the `-c projects` override above
  skips it. cursor-agent's `--trust` and Muse's `--trust-workspace` skip
  theirs. Hooks fired in all four.
- On dev0, claude's hooks in a tmux pane behaved as on the Mac: they got
  `$TMUX_PANE`, could write the crew state directories, and their chain
  reached the tmux server. Under plain ssh with no tmux, the hooks still
  fired and inherited `MU_REMOTE_KEY`, and the chain ended at `sshd`.
- `mule exec --host dev0` carried a read of the remote log back in 3.4 s.

Still open: `turn_failed` for codex and Muse, codex and cursor-agent skill
locations, and Muse's session store.

## Units

Each unit ends green on its repo's gates, and changes no pi behaviour. Its
acceptance check must be able to fail.

| Unit | Repo        | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Accepted when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U0   | spike       | Run claude, codex, muse and cursor-agent in a throwaway tmux session started from a terminal, with a logging hook. Record every D6 event payload, `$TMUX`, `$TMUX_PANE`, `TMUX_TMPDIR`, the full argv chain to the tmux server, `CLAUDE_PID`, the marker env, and the hooks native subagents and nested `claude -p`/`codex exec` runs fire. Check that Stop fires after Escape and after the turn's text reaches `transcript_path`, that a stop hook can block, the longest hook timeout, Escape, the fresh command, a 3 KB multi-line paste, auto-approve flags, trust dialogs and hook trust in a fresh mu worktree, and the muse rows. From inside each harness's hooks, check that they can write the inbox, write mu's DB, reach tmux and write museum's meta directory, and that `muzzle run` can take its slot locks. Check whether claude rewrites transcripts in place, where muse keeps sessions, and whether cursor-agent can export a chat. On a remote host, check that a codex worker completes a turn and that `mule exec` carries a `murmur pane --remote` read | every `VERIFY` cell filled, with log excerpts                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| U1   | murmur      | inbox, drain, pane-option publishing, nested rule, store additions, `source`, pi's claim over inbox incumbents, `murmur pane`, ARCHITECTURE amendments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 20 concurrent writers and one 1 MB event are applied in name order with no partial event; a dead server's inbox is deleted; the drain sets `@murmur_pane_state`; an event from a harness nested under pi is dropped; pi re-claims its pane after an inbox claim made during its `/new` window and after a store reset, keeping the attention rows; a pi nested under a live claude is refused and claude's attention survives; a launcher-plus-binary chain counts as one harness; the snapshot is byte-identical to before |
| U2   | murmur      | `murmur hook` rows claude, codex; `murmur hook mu`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | U0 fixture payloads drive every vocabulary transition; a claude Stop carries the turn's text read at hook time                                                                                                                                                                                                                                                                                                                                                                                                              |
| U3   | murmur      | rows cursor-agent, muse; `--remote` area; pi extension's store-free fallback mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | same; a remote-keyed event never appears in the remote node's store; in fallback mode the pi extension opens no store                                                                                                                                                                                                                                                                                                                                                                                                       |
| U4   | murmur      | merge-safe `init`/`doctor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `init` twice leaves a foreign `SessionStart` entry intact and adds nothing the second time                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| U5   | mu          | harness table; `AgentChannel` at the wait seam (state, watch, baseline, receipt, fence, last text) with `ctl` and `mux` implementations; contract suite; an import test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | the listed call sites import only `src/channels` (enforced by a test); behavioural assertions are unchanged, though test import paths may change; the contract suite passes against `ctl` and `mux`                                                                                                                                                                                                                                                                                                                         |
| U6   | mu          | send, interrupt, fresh and `command` through the channel; the agents `channel` column                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | same import test for the delivery call sites; contract suite still green against `ctl` and `mux`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| U7   | mu          | `orchestrate`/`--as`, `MU_ORCHESTRATOR`, `MU_AGENT_CLI`; the `mu_delegate` gate; D10 guard; `murmurAvailable(cli)`; VISION constraint 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | a pi orchestrator started by `mu orchestrate` still has `mu_delegate` and sees its delegates in `mu state`; its delegates and workers do not get `mu_delegate`; it gets no close nudge; a spawn with a marker env set and no server fails with the typed error; `--as` is refused while a live wait holds the caller; a missing pi extension still warns with claude hooks installed                                                                                                                                        |
| U8   | mu          | `hooks` channel: send through tmux paste, ack, `answer`, steer refusal; VISION §6 and the paste comments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the contract suite passes against a fake harness that writes inbox events: ack, `unknown` on no ack, refusal when blocked, typed steer refusal; `rg "no tmux paste" VISION.md` is empty                                                                                                                                                                                                                                                                                                                                     |
| U9   | mu          | `hooks` interrupt, fresh, abort, settle, last text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | same fake harness: mu's `interrupted` makes the agent sendable as `idle?`; a send with no ack reports `unknown`; settle returns the last text                                                                                                                                                                                                                                                                                                                                                                               |
| U10  | mu          | `mu hook stop` with its guards; `keep_driving`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | live claude orchestrator: keeps driving through two events and delivers each once; allows the stop while a background `mu wait` runs; stops after the cap of empty blocks; allows a stop when nothing is owed; a worker gets one close nudge; a `claude -p` run by a managed pi consumes nothing                                                                                                                                                                                                                            |
| U11  | mu          | `task check`/`verdict`; `checks`; `--if-ready` rule; re-fold of stored `check` ops inside `upgradeSchema`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | a killed claude orchestrator's replacement sees an unanswered check in `mu state`; `--if-ready` waits for a missing verdict; `check` ops synced before the upgrade appear after it, including verdicts that arrive out of hlc order; the schema version stays 13; `SEGMENT_FORMAT_VERSION` is unchanged                                                                                                                                                                                                                     |
| U12  | mu          | D11 remote path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | a remote claude worker on a test host: send is confirmed on the next read, `collect` applies its CLOSE block, and the remote node's `murmur status` does not list it                                                                                                                                                                                                                                                                                                                                                        |
| U13  | mu + murmur | the pi fallback (D15)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | the contract suite passes against pi on `hooks`; with `MU_PI_CHANNEL` unset, pi's behaviour and the contract suite on `ctl` are unchanged                                                                                                                                                                                                                                                                                                                                                                                   |
| U14  | museum      | `tick`, flush stamp, timer, recursive sources, layout, `museum hook` meta record, filter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | a claude and a codex session each appear in the store; the filtered claude copy has no `api-request` records; a final turn is in the store within one timer period after `SessionEnd`; pi sessions sync exactly as before                                                                                                                                                                                                                                                                                                   |
| U15  | museum      | normalisers, discovery, dates, `stats`/`calls`/`find` on all formats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `stats` returns the same merged message and call counts for one fixture session in each format; legacy root-level pi files are found                                                                                                                                                                                                                                                                                                                                                                                        |
| U16  | muzzle      | `muzzle hook cursor`; Muse Code mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | U0 fixture payloads: a matching cursor command is denied with the exact line, the rerun passes, a non-matching command passes                                                                                                                                                                                                                                                                                                                                                                                               |
| U17  | muzzle + mu | merge-safe `muzzle init`/`doctor`; `status --json` holder pid and pane; mu treats a queued holder as waiting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `init` twice leaves foreign entries intact; a worker queued behind a held slot is never reported stalled                                                                                                                                                                                                                                                                                                                                                                                                                    |
| U18  | dotfiles    | D16 crew dotfiles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | each example matches what the matching `init` writes, checked by a test that runs the `init`s into a temp home                                                                                                                                                                                                                                                                                                                                                                                                              |
| U19  | mu + org    | skill, recipes, prompts, docs; D16 org                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | eval cases E1–E7 pass (U24); `rg -i "pi-first\|pi is the agent\|crew of pi agents" ../org docs skills README.md` is empty                                                                                                                                                                                                                                                                                                                                                                                                   |
| U20  | mu          | D17 local: harness from key, launch without prompt, `hooks` write (brief file, `.mu/.gitignore`, pointer paste), `hooks` reconcile, model and approval flags, `mu agent list` harness and channel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | a claude orchestrator spawns a local codex worker and a local pi worker, and both close their tasks; killing mu between pane and claim and replaying delivers exactly one brief; a worker that never submits ends `unknown` and is promoted to `sent` by `reconcile` once its inbox shows the run; the worktree stays clean                                                                                                                                                                                                 |
| U21  | mu          | D17 remote: host capability probe and column, conditional pi steps, remote brief file and size cap, `isCommandGate` for harness launchers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | a remote claude worker and a remote pi worker run on one test host from one orchestrator; a claude-only host passes `host check`; a spawn for a harness the host lacks fails with the typed error; a 97 KB brief fails with the typed error                                                                                                                                                                                                                                                                                 |
| U22  | mu          | the auto executor's `hooks` path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `mu task auto --cli claude` dispatches a task; a claude `StopFailure` triggers one retry that rewrites the brief file and pastes the pointer; the run closes; a codex task with unverified `turn_failed` parks as `needs_human`                                                                                                                                                                                                                                                                                             |
| U23  | mu          | `mu init`: hook entries and per-harness worker skill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `init` twice installs the skill once per harness and leaves foreign entries intact; nothing is written under `~/.agents/skills/`; pi lists exactly one `mu` skill                                                                                                                                                                                                                                                                                                                                                           |
| U24  | mu          | evals on real harnesses: E1 dispatch and merge, E2 finding triage with a cross-family refuter, E3 review gate, E4 crash and replacement orchestrator, E5 remote worker, E6 interrupt and resend, E7 a mixed crew (one orchestrator, local codex and pi workers, remote claude and pi workers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | each case meets its written pass criterion with claude, codex and pi orchestrators                                                                                                                                                                                                                                                                                                                                                                                                                                          |

U0 also checks each row's model, auto-approve and trust flags and
skill location. U0 gates everything. U1–U4 and U5–U6 run in parallel. U8 onward needs U1
and U6. U13 needs U3 and U9. U14–U15 are independent of mu. U16 is
independent; U17 needs U4 and U7. U18 needs U4, U10 and U17. U20 needs
U9; U21 needs U12 and U20; U22 needs U20; U23 needs U4. U24 runs last.

U5 and U6 move code out of 22 `src` files that import `src/ctl/*` directly,
touching about 41 test files. Expect them to exceed the 300-LOC unit guide
in moved lines; new logic stays under it.

Suggested releases: murmur U1–U4; mu U5–U7; mu U8–U11; mu U12–U13; museum
U14–U15; muzzle U16–U17; mu U20–U23; crew dotfiles U18; mu and org U19
and U24.

## Risks

- **A harness's hooks have less access than its shell.** Its inbox, mu
  hook and museum record are inert until the launcher's writable-directory
  flag is passed through `MU_<HARNESS>_COMMAND`. U0 decides.
- **A sandbox refuses the tmux socket.** That harness cannot orchestrate on
  the Mac (D10).
- **Hook drift.** Vendors change hook schemas without notice. Each row has
  fixture payloads, and `doctor` checks the harness version.
- **Paste into a TUI.** A dialog that opens as the paste lands loses it.
  Confirmation makes the loss visible; it does not prevent it.
- **Spoofed state.** Covered in D3. The worst outcome is a misdirected
  paste into a running agent.
- **Nested agents.** Covered by the D3 nested rule and the D7 guards. A
  harness whose process tree U0 cannot read reliably falls back to
  `MU_AGENT_CLI` matching alone.
- **Channels drift apart.** The contract suite runs every verb against all
  three implementations, and the import test keeps call sites on the seam.
- **4.3 peers ignore verdicts.** Stated in the release notes (D8).
- **An undrained inbox.** Capped per pane (D3).

## Out of scope

- Removing or demoting any pi integration.
- `mu_delegate` children on non-pi harnesses.
- Any murmur snapshot change.
- Session-messaging and live-attach commands of any harness.
- herdr and Rex parity work beyond the `mux` channel.
- A statusline integration.
- cursor-agent session backup.

## History

Drafts 1–3 (2026-11-04 and 2026-11-05) planned "mu 5", which demoted pi to
the hook path, deleted the control socket, `mu_delegate` and steer, and
broke the schema once. The premise was that pi could no longer reach models.
A managed pi build that reaches them was found and verified with the whole
of mu-crew on 2026-11-05, so draft 4 kept pi as it is and made the work
additive. Drafts 2–4 are kept outside the repo.

Four refutation rounds shaped the design. Every finding that still applies
is reflected above.

- **Round 1** (four reviewers on draft 1): Stop does not fire on interrupt
  (D4 `interrupted`, stale reads `unknown`); hooks run sandboxed (D3 hooks
  only write files); remote workers had no pane key (D11); CLOSE text needs
  64 KB (D3, D8); keep-driving cannot wait in a short hook (D7); `run_count`
  must bypass the status cache (`murmur pane --json`); `session_start`
  sources and claim on any event (vocabulary); verdicts must be records
  (D5); a pane per check does not scale (D5 cap); hook formats differ and
  Muse hooks need trust (D6, D13); caller identity must not be guessed (D9);
  permission prompts need an answer path (D4); acceptance checks must be
  able to fail (units).
- **Round 2** (two reviewers on draft 2): an atomic append cannot carry
  64 KB (D3 one file per event); reading the transcript at fold time races
  (D3 hook-time read); `--peek` re-fires events (D7 consuming wait); the
  Stop hook supersedes a background wait (D7 allows the stop); nothing
  published pane options (D3); a remote pane key broke single-writer (D11);
  the ARCHITECTURE amendment was understated (D3, four amendments); no
  rotation and pane-id reuse (D3); `checks` capture and id collisions (D5
  ULID); `--if-ready` had no rule (D5); the lease "job channel" is
  `mule exec` (D11); identity gaps (D9); the cap counted every timeout (D7);
  mu's `interrupted` is unconfirmed (D4 `idle?`); museum's in-transcript
  record, search depth, claude subagent transcripts, cursor-agent SQLite,
  the lost session-end flush, git state at sync time, per-format counts,
  and privacy (D12).
- **Round 3** (one reviewer on draft 4, against mu ef1f23e0 and murmur
  ef229d6):

  | Finding                                                                                                    | Severity | Disposition                                                          |
  | ---------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
  | murmur's snapshot rejects unknown keys and any other version; new fields would force lockstep upgrades     | critical | D8: the snapshot does not change                                     |
  | `mu orchestrate` sets `MU_MANAGED_AGENT`, which hides `mu_delegate` from a pi orchestrator                 | critical | D9, U7: the gate lets `MU_ORCHESTRATOR` through                      |
  | No rule for a pi-owned pane; an inbox claim can permanently silence pi's extension                         | critical | D3: `source` column, pi wins its pane, no inbox claim over a live pi |
  | `CAPTURE_VERSION` never reaches peers; a 4.3 peer silently ignores `checks`                                | high     | D8: stated facts, re-fold migration, release notes                   |
  | Nested harnesses inherit the managed env and fire `mu hook stop` as the parent                             | high     | D3 nested rule; D7 guards with `MU_AGENT_CLI`                        |
  | herdr and Rex already have a third transport                                                               | high     | D4: `mux` is the third implementation; delivery through `MuxBackend` |
  | The channel interface missed fence, receipts, baseline, `command`, handshake; 22 files import ctl directly | high     | D4 interface and the stays-on-ctl list; U5/U6 split; LOC note        |
  | The pi fallback depends on the extension it is meant to survive, and makes two writers                     | high     | D15: store-free mode; the failure it covers is stated                |
  | U5's acceptance could pass with an unused interface                                                        | medium   | U5/U6 import test                                                    |
  | `MU_PI_CHANNEL` was read nowhere persistent                                                                | medium   | D4, D8: agents `channel` column                                      |
  | VISION §6 and code comments forbid paste, and the paste ships before the docs                              | medium   | D4, U8                                                               |
  | "Checks both" in `murmurAvailable()` hides a broken pi setup                                               | medium   | D13: `murmurAvailable(cli)`                                          |
  | CLOSE from hook text contradicted "never on hook state alone"                                              | low      | D3: same trust as pi's ctl last text                                 |
  | The inbox hash did not map to the store key                                                                | low      | D3: events carry the store location                                  |

- **Round 4** (two reviewers on draft 6: the draft 5 ownership mechanisms,
  and D17):

  | Finding                                                                                                    | Severity | Disposition                                                                        |
  | ---------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
  | An argv initial prompt delivers the brief before the claim, the `sending` journal and the executor's guard | critical | D17: launch without a prompt; brief file plus pointer paste in the journaled write |
  | The nested rule had no concrete root, matched by process name, and would drop launcher-wrapped harnesses   | high     | D3: walk to the tmux server pid, match argv, collapse launcher chains              |
  | "pi always wins" undoes the nested-agent refusal and deletes live attention                                | high     | D3: replace only a dead or non-ancestor incumbent; keep attention                  |
  | murmur store columns force a reset that silences older pi extensions                                       | high     | D8: release rule, compatible-since stamp                                           |
  | mu has no migration ladder for a "v14"                                                                     | high     | D8: `upgradeSchema` additions at schema 13; re-fold in the same transaction        |
  | `MU_ORCHESTRATOR` leaks into helpers and remote env                                                        | high     | D9: stripped in `delegate-process` and `LOCAL_ONLY_ENV`                            |
  | A managed pi orchestrator loses its delegates in `mu state`                                                | high     | D9: `currentCallers()` union                                                       |
  | A shared `.mu/brief.md` without a worktree; untracked `.mu/` dirties worktrees                             | high     | D17: per-attempt name, `.mu/.gitignore`                                            |
  | `hooks` spawns could never leave `unknown`; brief never pinned                                             | high     | D17: `hooks` reconcile branch                                                      |
  | The executor's retry is built on ctl facts                                                                 | high     | D17: `session_id` and `run_count` baseline; pointer retry; verified rows only      |
  | Host capabilities assumed remote `MU_<HARNESS>_COMMAND`; nowhere to store them; pi steps mandatory         | high     | D17, D8: probe the literal command, new column, conditional pi steps               |
  | pi's `--approve` is folder trust, not approval                                                             | high     | D6, D17: pi gets no approval flag                                                  |
  | Close nudge and implicit `-w` would change a managed pi orchestrator                                       | medium   | D9: worker-only                                                                    |
  | Hook-side `server_kind` can disagree with the collector                                                    | medium   | D3: the drain maps raw socket and pid                                              |
  | A pi-tree check on every drain is costly                                                                   | medium   | D3: only on an unclaimed-pane claim, cached                                        |
  | `mu init` does not exist; `~/.agents/skills` is also pi's                                                  | medium   | D17, U23                                                                           |
  | cli keys are free-form; harness launchers are classed as command gates                                     | medium   | D17: harness from key; `isCommandGate`                                             |
  | Remote briefs have no stdin path                                                                           | medium   | D17: 96 KB cap                                                                     |
  | Hook and folder trust can suppress every readiness event                                                   | medium   | D6 trust row, D17, U0                                                              |
  | A `hooks` pi still serves ctl                                                                              | low      | D15: ctl for handshake, delegates and doctor only                                  |
  | D6 flag cells from `--help`                                                                                | low      | D6                                                                                 |
  | U20 and U22 checks could not fail                                                                          | low      | U20, U22                                                                           |

- **U0, local** (2026-11-05): the results above changed D3 (chain-based
  placement, anchor identity, payload text), D4 (clear before paste), D6
  (every cell observed), D7 (anchor guards, no keep-driving on Muse), D11
  and D12 (anchor fields).

Findings that only concerned removing pi no longer apply: `next --refute`
losing its once-key, pi having two state sources during the switch, and the
order of deleting the control socket.
