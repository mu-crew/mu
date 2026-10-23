# mu-next

**mu-next is a tool whose user is an agent.** Every verb, output, error
and line of prose is designed for a model to read and act on; only the
dashboard is designed for a human. The measure is how cheaply an agent
reaches the *correct* next action: tokens read and written, and
mistakes it cannot make.

Minimal but still practical: the smallest layer over tmux/herdr and
SQLite that a crew uses all day without friction. Deleting code only
helps when what replaces it is cheaper for the agent. Built on the
`mu-next` branch, then cut over on a flag day.

Revision 2 (2026-10-23) folds in an ultrathink run over revision 1:
12 finders, 85 findings (53 accepted, 24 rejected, 8 duplicate), and a
4-way interface tournament. The run lives in workstream `next-ut`; each
section below cites the accepted finding ids it answers.

## Rules

1. **Guarantees are code.** Atomicity, locking, cross-machine merge,
   exact delivery, identity. Each has a measured failure behind it.
2. **Procedures are prose only if one sentence and not needed by every
   agent.** Otherwise a verb. Write the sentence before cutting code.
3. **Silent code beats taught prose.** A verb costs one `--help` line;
   a guard costs nothing until it fires, then one line.
4. **Errors and hints teach at the decision point**, not in the skill.
5. **Accept what models reach for.** Repeatedly guessed flags, keys
   and columns become aliases or teaching errors.
6. **Context is the budget, prose and output alike.** Output was
   ~14M tokens in the mined sessions (an upper bound: whole bash
   results); skill reads 3.5–6.8M. Both are capped and tested.
7. **Promote back.** Prose models get wrong twice becomes a verb.

## Evidence

mu 3.x: ~55k LOC src, ~75k test, 18k words of skill. Audit by subsystem
plus museum mining (2,739 sessions, 23,443 mu calls, 4% errored).

| Kept as code | Failure behind it |
|---|---|
| trigger capture into `ops`, ctx inside the write txn | a missed op silently breaks sync, history, rebuild |
| HLC + per-field LWW, per-machine JSONL segments | 2 machines; ~2.5k entities edited on both |
| ctl socket: send/fresh/wait/abort/status | `/new` paste lost 3 of 6 sends; 1,883/1,883 real sends used ctl |
| spawn lock, rollback, env injection | parallel spawns dropped/duplicated agents |
| reaper with pane-id CAS | 877 reaps |
| atomic claim, cycle guard | double ownership; sync-merged cycles |
| delegate `record` | 107 of this run's 213 notes; gates read them (`we_record_loss`) |
| nudges (keep-driving, close) | ~2/3 of 95 "carry on" prods are real stalls (`um_prods_outage`) |

| Cut | Why it is safe |
|---|---|
| card TUI (~29k with tests) | replaced by a 4-tab dashboard |
| jj/sl/cp VCS backends, staleness, commits, orphans | 582 git workspaces, 0 jj/sl |
| general undo | 2 uses, both un-teardown; teardown becomes soft |
| tmux paste send, kick, adopt | 0, 2, 2 real uses |
| migrate sidecar, legacy ops, resumable SHA | finished or replaced (see Cut-over) |
| delegate footer extras, refute nudge, `mu link` | conveniences; pi packages ship the skill (the queue stays: admission control) |
| ~950 words of skill explaining mu's own flags | verbs and errors explain themselves |

Second archive (Mac + work devserver, Apr–Oct, 32,543 mu calls, 5.2%
errored) agrees: `-w` on 87% of orchestrator calls; ~11% of `mu sql`
fails on guessed names (49/455; 30/173 since Sep); `task note` flag
guesses again top the list (`--note`, `-m`, `--message`, `--text`,
`--content`); `KeyError: 'id'` ×31; output ≈18M tokens, `task notes`
alone 8.4M (median 4k chars). Strict `Next:` follow is lower still:
6.5% (265/4,106). Bare "carry on" prods: 214 in 69 sessions. New: in
May, workers ran `cd $(mu workspace path <self>)` 5,755 times (98% into
their own workspace, which was already their cwd), because briefs said
so: a brief-template habit, not a mu need. Rare verbs stay rare (kick
~2 real, adopt 3 since Sep); `--discard-workspace` 162,
`--workspace-from` 70, `workspace refresh` 110 since Sep.

Mining corrections from the run: `-w` is on 86% of calls (91%
orchestrators); ~1/3 of "carry on" prods follow API errors, not stalls;
most `sleep` loops wait for `/new` resets (≈199) or poll until CLOSED
(≥36); pane reads are mostly status checks, ~75/778 scrape context %.

## Interface (tournament winner: JSON-only, 6/6 verdicts, plus steals)

Four extremes were judged pairwise in both orders: JSON-only 6/6,
next-driven 3/6, terse-line 3/6, SQL-native 0/6. The interface is
JSON-only's contract with the winning ideas of the others.

**Envelope.** Structured verbs return `{ok, data, next}`. Under `--json`
errors go to **stdout** as `{ok:false, error, message, next}` with a
non-zero exit, so `2>/dev/null` loses nothing (`js_envelope`, 326 calls
did that). Keys equal SQL column names; `id` is the task's `local_id`
(never the integer PK); output aliases only, op payloads keep history
names (`co_id_rename_boundary`).

**Per-verb format.** Waits, `sql`, `state`, `agent list`: JSON. Notes,
`show`, `list`, `tree`, `log`: one text record per line,
`kind id STATE key=value`, `more=N`/`cut=N` when truncated. Agents chose
JSON for waits (90%) and text for notes (92–96%), and pipe 51% of
notes/show to line tools (`js_prose_regress`, `js_tty_degenerate`).

**Output caps** (tested like prose): list records ≤ 400 chars, a
result ≤ 4 KB with a count of what was cut (`cc_output_unbudgeted`).
Briefs, reports and verdicts are never truncated in the notes view:
they are the content (a real brief is 4.8k chars with its scope guard
at the end); the cap applies to the other notes, summarised as `more=N`.
Every cut names its way back: `more=N next=mu task notes <id> --all`
or `--from <note>`; `show <id> --note <n>` prints one note whole.

**Notes default view.** Brief (note #1, kind `brief`) + report (last
`report`) + verdicts (`verdict`) + ordinary notes newer than the
report or the last 3, whichever is fewer (an umbrella's running
instructions live there) + `more=N`. Notes get a `kind` column
set once at INSERT and never updated (notes are append-only; an
UPDATE syncs as a `{kind}`-only put that a peer cannot match):
`task add --note` and `spawn --task` write `brief`; `task note
--report` and `task close --report <text>` write `report`; `record`
writes `verdict`; `close` writes `close`; else `note`. With no
`report` note, the view shows the closer's last `note` instead,
decided at read time. Import classifies 3.x notes the same way
(first note = brief, last non-`CLOSE:` = report, `REFUTER`/`VERDICT:`
= verdict). 483/1,197
worker re-reads would have lost the brief under last-5; 1,132 tasks end
with a `CLOSE:` note, not the report (`cc_last5_hides_brief`,
`we_last_note_wrong`).

**Next contract.** Agents follow hints literally 13–14% of the time
(6.5% on the second archive), barely over 7.8% chance, but 28–58% for state-advancing hints
(`claim`, `spawn`, `note`, `close`) and 0–11% for reads
(`nx_next_follow_rate`). So:
- one rule set over current state computes `next` on every call, the
  only source of hints (dashboard shows the same) (`np_stale_at_exec`);
- only state-advancing moves; reads are never hinted; usually empty;
- executable as printed: POSIX-quoted, real ids, no `<…>`, `...` or
  `a|b`; a hint mu cannot fill is omitted; a test runs every hint
  through a shell parser (`np_not_executable`, `js_next_placeholders`);
- safe before destructive; lists are marked `seq` or `alt`; sequences
  are never truncated; destructive moves carry `--if <rev>`
  (`np_ranking_is_policy`);
- reference hint: after `send`, `agent wait <a> --after-runs <n> --inc <i>`.

**Guards.** `--if <rev>` on membership-changing and destructive verbs;
teardown needs a preview revision; wrong ids return read-only
`candidate_ids`, never a fuzzy write; ambiguous ctl delivery returns a
receipt to check, never a resend (`send` gains a `msgId` the extension
remembers for its last N sends, queried by `status`; additive ctl
change); a timeout is `ok:true` with
`timedOut`; streaming verbs emit NDJSON.

**Executor.** `mu next [--dry] [--hold] [--cap N]` performs moves that
need no judgement for tasks the orchestrator authorised. Authorisation
is explicit and stored: `mu task auto <ids|--blockers-of u> --cli
<key> [--worktree] [--max N]` sets `auto` on those tasks with the model
key, workspace mode and a run ceiling; `--off` clears it. Ready is not
permission: `next` acts only on `auto` tasks. `auto`, its cli key,
worktree mode, run counter and spawn-replay records live in a
machine-local `task_auto` table that never syncs. That alone does not
stop both machines dispatching a task authorised on each (claims are
per machine; 754 task keys were edited on both machines). So `auto`
also writes a synced `dispatch_host` on the task, the one machine
allowed to dispatch it; `next` on any other machine skips it, and
authorising a task already owned by another host refuses with one
line. Concurrent authorisation on both sides resolves by LWW, and the
loser's `next` stops at its next ingest. It will spawn and
claim ready tasks, send briefs, reap, retry dead or API-errored workers
with brief + report + "previous attempt died". This is also the resume
path after outages and reboots: 30 identical "API dropped, continue"
turns and a hand-built recovery watcher in the mined sessions
(`um_resume_workflow`). Opt-in `--refute` spawns a checker as each task
closes, briefed from the pinned brief and actual report.

**Aliases** for guessed flags: `note -m/--message/--note`,
`close --note` = `--evidence`, `list --all/--owner/--mine`; `-i/-e`
stay accepted and optional (`um_flags_partly`, `pv_impact_effort_flags`).

## Scope and identity

- **Explicit scope.** Verbs require `-w`; workers use their injected
  `MU_WORKSTREAM`. Missing scope is one line:
  `no workstream: pass -w <name> (tmux session mu-auth: -w auth)`.
  No `$MU_SESSION` or tmux-session fallback for verbs: a silent
  misroute is worse than a cheap error. The dashboard reads the
  session only to pick its starting tab (`mi_views_no_scope`,
  `mx_ambient_ws`; user decision).
- **Spawn injects** `MU_MANAGED_AGENT`, `MU_AGENT_NAME`, `MU_WORKSTREAM`,
  `MU_CTL_SOCK`, absolute `MU_DB_PATH`, `MU_STATE_DIR`. Claim, note
  authorship, nudges and the no-recursion delegate guard depend on
  them (`kg_spawn_env`). Workers get identity and task in the brief;
  `mu me` stays as an alias of `state --me`.
- **Local ownership.** Claim CAS is per machine; `owner_id` never
  syncs; names are unique per workstream (`kg_local_ownership`).
- **Role is advisory**, not a security boundary. Read-only auditors
  get no worktree (`mi_role_unenforced`).

## Kernel

**Schema.** `workstreams` (+ `torn_down_at`; every view and
existence check filters it out; `init` of a torn-down name hard-deletes
the old one after a preview, since names are reused: `hail`,
`scratch` ops show put/del/put), `agents` (+ `cwd`), `task_auto`
(machine-local),
`tasks` (+ `scored` flag: impact/effort given vs defaulted;
`dispatch_host`, synced),
`task_edges`, `task_notes` (+ `kind`), `ops`,
`machine_identity`, `op_ctx`, `sync_peers` (`co_sync_peers_missing`);
views `ready`, `blocked`, `blockers`, shared by agents and dashboard.
`ready` order, used by `mu next` dispatch: scored tasks by
impact/effort desc, then the rest oldest first (`pv_impact_effort_flags`).
`impact`/`effort_days` stay NOT NULL with defaults until flag day
(`co_nullable_blocks_ingest`). Trigger-enforced for **local writes
only** (`WHEN applying=0`): claim CAS, close needs evidence, close
refuses open blockers. Ingest and import accept what the log says
(peers can merge into states no local write allows; close and its
evidence are separate ops; 2 live CLOSED tasks have open blockers);
doctor reports such states. A RAISE during ingest would roll back the
segment and stall sync forever. Natural keys immutable
including `INSERT OR REPLACE` (`sp_insert_or_replace`). A BEFORE INSERT
guard cannot see the conflict clause, so it also aborts `INSERT OR
IGNORE`: mu's own idempotent inserts (`ensureWorkstream`, `addEdge`)
become `INSERT … WHERE NOT EXISTS`, and the guard matches the natural
key, not only `id`.

**Verbs.** Each guarantee is one line naming the tests that protect it.

| Verb | Guarantee (tests) |
|---|---|
| `workstream init / teardown` | session + row; ordered teardown: kill session, then rows; soft delete (`workstream`) |
| `agent spawn [--task id] [--worktree] [names...]` | lock, row, pane, env, ctl handshake, rollback; claim only after the pane exists, release on rollback; replay returns the existing delivery (`spawn-ctl`) |
| `agent send [--fresh/--interrupt]`, `wait`, `abort` | ctl only; send returns `runs` + incarnation; wait refuses an incarnation mismatch; timeout after write = delivery unknown, check never resend (`extension-mu-pi`, `ctl-client`) |
| `agent close [--discard]`, `list`, `read` | reaper + ghost prune; close refuses a dirty worktree (`agents`) |
| `task add [--triage] [--blocks u] [ids...]`, `block`, `unblock` | cycle guard; batch create (`edges`) |
| `task claim`, `release`, `open`, `accept` | CAS; release returns IN_PROGRESS to OPEN (`claim`; 78/65/46/749 uses: `kg_release_reopen`, `pv_substate_verbs`) |
| `task close [--as s --why] --evidence` | status + substate + evidence, one op group (`lifecycle`) |
| `task wait <ids> / --blockers-of u` | streams each close; exits on all closed, dead owner, or settled agent (`tasks-wait`; `we_wait_any_not_loop`) |
| `task tree <id> [--down]` | open-only, capped (`pv_tree_view`: one umbrella reaches 870 tasks, 3 open) |
| `state [--me]`, `log [--tail]`, `notes`, `show` | caps; `renderOp` trimmed to the new intents |
| `next [--dry]` | executor above |
| `db [sql]` | in-process on better-sqlite3 like 3.x `mu sql`, inside the context wrapper: `foreign_keys=on`, `busy_timeout=5000`, per-connection TEMP views with the resolved workstream and agent as literals (SQLite rejects view parameters); user `BEGIN`/`COMMIT` refused; writes captured and flushed; `no such column` → one-line did-you-mean + column list, non-zero exit (`um_sql_column_guess`). `mu db --shell` opens the sqlite3 CLI read-only |
| `sync`, `rebuild`, `doctor`, `host add/check/init` | doctor: mux, integrity, cycles, drift, schema/capture version, trigger checksum, sqlite3 version, network mount, case collisions |

**Plain `sqlite3` is read-only.** It defaults to `foreign_keys=0` and
`busy_timeout=0` (cascades silently skipped, 0 ops logged), cannot
enable `recursive_triggers` for others, and may run SQLite < 3.42
(`unixepoch('subsec')` → zero-time HLCs). Writes go through mu or `mu
db` (`kg_sqlite_fk_off`, `mi_sqlite_cli_version`). Reads may lag other
machines until any mu call syncs.

**Sync contract.** Every verb ingests peer ops before and flushes its
own after, including on error; `mu db` writes flush too
(`kg_ambient_sync`). The DB inside `MU_SYNC_DIR` is a hard refusal: a
WAL DB copied without `-wal` passes `integrity_check` with rows missing
(`pv_fleet_hazards`).

**Ctl versioning.** Protocol version + `hello` (ext build, served ops);
changes additive only; a new CLI checks served ops; outdated live
agents: ctl `/reload`, else mux reload, else respawn (`mi_ctl_versioning`).

**Mux seam (tmux, herdr).** `available`, `ensureSession`,
`killSession` (herdr: workspace close, group refusal surfaced),
`spawnAgent(name, cli, cmd, cmdSource, cwd, env)` (tmux one step;
herdr shell pane, readiness retry, `agent start --kind`, refuses
command overrides), `listPanes`, `paneAlive`, `killPane`, `capture`,
`attachCommands(target)` → ordered steps, some optional, may fail with
a reason; optional `paneStatus` for non-pi agents on herdr. Agent
state is ctl-only for pi. Pane-title identity is retired
(`mx_herdr_spawn_inputs`, `mx_no_session_kill`, `mx_attach_contract`,
`mx_native_status`).

**Worktrees.** The worker's cwd *is* its worktree; briefs never tell it
to `cd` there (5,755 redundant `cd $(mu workspace path <self>)` calls
in one month of the second archive). `spawn --worktree [--from ref] [--root repo]` runs
`git worktree add --detach` (a named branch breaks name reuse: 102
reused names, `pv_worktree_reuse`); close refuses dirty, `--discard`
overrides; a branch is made only to keep unmerged commits. Git only.
Refresh is one skill sentence: before a `--fresh` send,
`git -C <cwd> fetch && git -C <cwd> rebase <base>` (base: `origin/HEAD`,
or the local main when work is merged locally and not pushed); on
conflict `rebase --abort` and tell the human. 3.x refresh is mu's only
fetch site, so the sentence must fetch (git refuses dirty trees itself; `pv_refresh_per_send`).

**pi package.** ctl server; `mu_delegate` (spawn, background wait,
post follow-up, `record` the verdict or no-verdict before posting,
admission control kept from 3.x (`MU_DELEGATE_MAX` running, a bounded
queue drained automatically, refusal past it; tests:
`extension-delegate` 273-335; this run hit 16+64),
no-recursion guard); one settle hook for keep-driving and close nudges.
Skill and prompts ship in the package.

## Remote workers

Low volume (~120 remote mu calls, 31 sessions) but the highest
friction per use: a 2,275-word recipe, held ssh channels, hand-copied
results. The root asymmetry is that a remote worker has no mu.
mu stays ssh-free: it never connects and knows no ssh flags (user
decision). Host profiles are templates mu fills in.

- **`mu host add dev --shell '<pane cmd>' --exec '<run cmd>' --fetch
  '<local fetch cmd>' --repo ~/repo [--max-sessions 1]`**,
  machine-local. `--fetch` runs locally and brings commits back (e.g.
  `git fetch ssh://dev/{cwd} HEAD`). Placeholders: `{env}`, `{cmd}`,
  `{local_sock}`, `{remote_sock}`, `{cwd}`. `mu host init dev --ssh`
  prints a starter template (the forward, `$SHELL -ilc`, env inside the
  command) for the user to edit; mu never runs it.
- **`mu host check dev`**: channel free, pi and extension versions,
  repo present, socket answers through the forward.
- **`spawn --host dev [--worktree] [--task t]`**: fills the pane template,
  creates the remote worktree via `--exec` (`git worktree add --detach`),
  records host, path and base as agent fields (no hand-written
  `REMOTE:` note).
- **`agent collect <a>`**: runs `--fetch` and prints the merge; records
  the collected HEAD. `agent close` (and the reaper) removes the remote
  worktree only if it is clean **and** remote HEAD equals the base or
  the last collected HEAD; otherwise it refuses, or `--keep-branch`
  leaves a remote branch `mu/<ws>/<agent>-<sha>`. A reap never deletes
  a remote worktree.
- **`--max-sessions N`** counts every channel mu opened for that host:
  attached panes, `--exec`, `--fetch`. At the cap mu refuses with one
  line naming the holder. Remote agents run in detached remote tmux,
  so `collect` detaches the pane first and `wait`/`send` reattach
  (the ctl forward rides the pane).
- Long remote gates are panes (`spawn gate-1 --host dev --command
  'npm test'`, wait on exit), never a held `ssh dev …`. One skill line.

**Close block (pi workers, local or remote).** Briefs end with one
contract:

```text
CLOSE: task=<id> evidence="<command + result>"
REPORT:
<report>
```

On settle, `agent wait` and `mu next` read `lastText` over ctl (not the
pane). The block counts only if it is the **final lines** of the
message and `task=` is the task this agent owns; otherwise it is
ignored (quoting the contract, echoing a brief or reviewing another
worker does nothing). It is applied once per settled run (keyed on
agent + incarnation + runs) as the report note and close, one op group,
the same writer as delegate `record`. A block for a task already
CLOSED is ignored; rework means reopen first. A malformed final block
writes "no close (malformed)", never a guess. `mu task close` keeps
working (both accepted; user decision), and is the only path for non-pi
agents, which have no ctl `lastText`. This also removes the "forgot to
close" stall behind 34 close-nudge fires.

Recipe target: ≤ 200 words, from 2,275.

## Dashboard

The only human surface. All workstreams, a workstream row above four
tabs; `scratch` marked. Starting tab from the tmux session, else latest
activity. Bare `mu` on a TTY opens it. Read-only; keys yank commands.

| Tab | Content |
|---|---|
| Tasks | sorted by latest op per task (`db_activity_sort_bypass`); CLOSED hidden by default; status + text filter persists; owner shown on IN_PROGRESS only; Enter drills to the notes view |
| DAG | open tasks + their frontier by default (`db_dag_unusable_default`: 1,781 roots, 57 open) |
| Agents | every workstream incl. scratch; ctl state, owned task, running tool + elapsed; Enter = scrollback, `a` = attach (user decision) |
| Log | `renderOp` tail |

Target ~2k LOC written fresh against this list, not trimmed from 3.x's
11.9k (`db_loc_target` rejected the 2.5–3k floor; `<1.5k` was optimistic).

## Prose budget

| Surface | Cap |
|---|---|
| SKILL.md | 600 words |
| One recipe | 250 words |
| All recipes | 4k words |
| `Next:` hint / error | one line |
| `--help` per verb | 3 lines |

Three refuters compressed real recipes under the cap with every
evidence-backed rule kept (refute+findings 94–219 words,
orchestrator-loop 214). Rules with a measured failure get a marker
block and a test that fails if the block is removed, as keep-driving
has today. Every 3.x rule gets a destination: recipe, verb, default,
or dropped (a table in the skill PR).

## Persistent capture

Triggers live in the DB file; `op_ctx` is a one-row main-schema table.
Plain writes are captured as a safety net, not a supported path.
- **The context wrappers own the transaction.** `withOpContext` and
  `withCaptureSuppressed` open `BEGIN IMMEDIATE`, set ctx, run, clear,
  commit. Run unchanged, 3.x wrappers leak ctx to other writers and
  leave `applying=1` after a crash; transaction-first wrappers block
  concurrent writers and roll back on crash (`sp_ctx_txn_boundary`
  refuter repro is the regression test).
- Reuse 3.x's payload builder (all changed columns) and DELETE
  triggers with the dying stash; the spike had neither
  (`sp_payload_one_col`, `sp_no_delete_trigger`).
- Trigger version folds into `schema_version`: refuse newer, recreate
  only if older, in one `BEGIN IMMEDIATE` with the stamp (`sp_downgrade`,
  `sp_migration_txn`).
- Minimum SQLite 3.42 checked by the triggers (abort below) and by
  doctor.

## Cut-over (flag day)

1. Kernel on `mu-next`: schema, persistent capture, apply/HLC/segments
   (resume kept for now), ctl, claim, mux seam; existing tests trimmed.
2. Verbs, pi package, dashboard.
3. Dogfood with its own `MU_DB_PATH`, `MU_STATE_DIR`, `MU_SYNC_DIR`,
   mux namespace (`MU_TMUX_SOCKET` / a private `MU_HERDR_SESSION`) and a
   freshly minted machine id, so it never writes the live DB, a real
   segment, or a live `mu-<ws>` session; discard it after
   (`co_dogfood_identity`).
4. Segment format: the version is checked **per line**. mu-next reads
   v1 and v2 and appends v2 to the same file; the manifest tolerates a
   mixed file; self-repair never truncates lines of another version.
   3.x refuses v2 lines loudly. (3.x checks the version by exact
   equality, so an unchanged reader would truncate its own v1 segment
   and stall on 14 old v1 peer segments.) Mixed-version test: a 3.x and
   a mu-next peer exchange ops; each refuses or applies correctly.
5. Rehearse: import a copy into a temp file and diff row counts and
   projection with doctor's drift code before any swap.
6. Flag day: stop all agents and release or reopen every IN_PROGRESS
   task (doctor refuses otherwise: ownership does not survive import);
   lock; import inside one read transaction, carrying machine id, HLC
   clock and `sync_peers` watermarks; checkpoint; rename DB with
   `-wal`/`-shm`; respawn agents; both machines upgrade together
   (`co_handover_quiesce`). Rollback is restore-and-new-identity: the
   3.x DB comes back with a fresh machine id, never the old one, since
   peers already hold its v2 lines and its HLCs could collide. Rolling
   back also moves every segment holding v2 lines out of `MU_SYNC_DIR`
   on every machine (archived, not deleted); otherwise 3.x stops at the
   first v2 line of each, including this machine's former segment, now
   read as a peer. Rollback is all machines or none.
7. History: old teardowns stay final (their deletes replay verbatim;
   only teardowns after the cut-over are soft) (`co_legacy_teardowns`).
8. Budgets: per-command overhead and import time measured against 3.x
   (53 MB segment: 0.3 s/pass; 94k-op replay 4.5 s) (`co_resume_perf`).

## Decisions during the build

Revision 2 fixes architecture, guarantees and contracts. The surface is
open and is decided by agent behaviour, not by judges reading designs.

**Eval harness (the judge).** ~10 scripted scenarios from real
failures: fan-out with gates; refute with verdicts; worker dies; API
outage then resume; wrong id; guessed flag; guessed SQL column;
worktree name reuse; long notes thread; teardown; remote spawn;
remote close via the CLOSE block; single-channel host under load;
delegate queue saturation with pending checks never issued. Each runs with a
cheap and a mid model against a candidate surface and records tokens,
calls, correct completion, and wrong or destructive actions. Baseline:
3.x on the same scenarios.

| Decision | Settled by |
|---|---|
| verb names, flags, grammar | tournament, eval-judged |
| text record format (notes/show/list) | tournament, eval-judged |
| `Next:` rule set | eval, one rule at a time |
| `mu next` executor authority | eval failure scenarios |
| error message style | eval: fixed in one retry? |
| SKILL.md and recipes under caps | tournament, eval-judged, cheap model |
| note `kind` assignment | during build |
| dashboard layout and keys | the user |

The kernel does not depend on these and is built first.

## Open

- `kind` on notes and soft-delete teardown need the flag-day segment
  bump; confirm both machines can upgrade together.
- Two 3.x bugs found by the run, fixable now: `bug_replace_rekey`
  (INSERT OR REPLACE re-keys with no tombstone), `bug_touch_regresses`.

## Process note

Some late highs were decided on one refuter or the orchestrator's own
code check instead of three refuters, because the queue was not
re-issued. They are marked in each task's ACCEPT evidence.
