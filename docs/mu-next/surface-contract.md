# mu-next surface contract

Status: **shipped, except the two rows marked TODO below.** This page is
the compact contract the mu-next build was made against: output, wait,
delegates, the CLOSE block and the prose and help budgets. It adds no
design. The design of record is [README.md](README.md); terms are in
[VOCABULARY](../VOCABULARY.md); the module map is in
[ARCHITECTURE](../ARCHITECTURE.md); what changed is in
[CHANGELOG](../../CHANGELOG.md). Where this page and the source
disagree, the source is right and this page is a bug.

Rules for readers and for the units that touch it:

- A unit that ships a contract updates ARCHITECTURE (module map) and
  VOCABULARY (term) in the same commit as the code.
- No module-map row, runnable guide snippet or `next` hint exists for
  code that has not shipped.
- No import and no flag day (user decision, 2026-10-25): mu-next runs
  beside 3.x with its own DB, state, sync dir and machine id; workstreams
  move by the [move recipe](../../skills/mu/recipes/move.md). Reading v1
  segment lines and accepting a v12 DB are cut.
- The build-time spelling tournaments (`dec_*`) were dropped. The README
  Interface defaults plus the amendments below are the contract;
  `v_eval_next` measures it with grammar-neutral judges.

## What ships

Schema 13, `CAPTURE_VERSION` 4, 26 classified tables and 4 views
(`PORTABLE_TABLES`: `workstreams`, `tasks`, `task_edges`, `task_notes`;
every other table is machine-local, see `src/db.ts`). The verbs and
their guarantees:

- **Output.** `{ok,data,next}` on stdout for every `--json` verb and
  every failure; `next` is computed once per result (`computeNext`).
  Task, log, state and notes reads are capped records.
- **Wait.** `mu wait` (typed refs, first event, one JSON result,
  `resume`, `--all`, `--until-text`, `--wave`, `--blockers-of`,
  `--on-stall exit|warn|steer|release`); `mu task wait` is its alias over
  task refs; `mu agent wait` is the agent-keyed form over the same engine. Producers
  (`spawn`, `send`, `claim --for`) arm a registered wait from real state.
- **Tasks and agents.** Batch `task add`, `--blocks`, note kinds,
  `--if <rev>` fences on membership changes and destructive verbs,
  task-bound spawn with receipts and replay, `mu agent check`, soft
  teardown with a preview revision, `mu human-needed`.
- **Executor.** `mu task auto` and `mu next` (`--dry`, `--hold`,
  `--workers`, `--refute`), `dispatch_host`.
- **Delegates.** A `mu_delegate` call is a `kind=delegate` task with a
  durable `call_id` (`mu delegates`, wave tally, `mu_delegate_reissue`),
  and `mu delegates run <call-id>` runs one with no multiplexer.
- **CLOSE block.** A pi worker's final `CLOSE:` lines are applied once
  per settled run by the wait engine (`src/close-block.ts`).
- **Remote.** Host profiles, remote spawn, `agent collect`, the close
  rule, remote command gates, recovery records.
- **Surfaces.** In-process `mu db query` (alias `mu sql`), four-tab
  read-only dashboard, pi package (no `mu link`), `mu pi migrate`.

- **Settle wait.** The pi extension's keep-driving nudge is the settle
  wait (`extension/nudge.ts`): every completed settle of an orchestrator
  runs `mu wait --first --on-stall exit --json` as its callers (no shell
  line parsed, no once-per-prompt latch) and continues the turn with the
  event. It stops when nothing is owed, a `mu human-needed` stop is open,
  the user cancels, or the wait fails. A cancelled wait drains through
  `MuRunOpts.drainMs`. Skipped under `MU_REMOTE=1` and in a nested pi.

- **Delegates without a multiplexer.** `mu_delegate` registers in any
  unmanaged pi. A spawn that fails `NoMultiplexerError` (only that error)
  runs the call through `mu delegates run <call-id>`: one child
  `pi --mode rpc`, no pane, no agents row, `transport: process`,
  `attach: null`. Admission, record and cancel are unchanged; `keep` is
  dropped; `/reload` leaves the run going; quit cancels it.

## Fixed contract

**Output.** Success `{ok:true,data,next}`; error `{ok:false,error,message,next,exit}`
on stdout with the real non-zero exit. `next` is `NextPlan`
`{mode:'seq'|'alt',commands:string[]}` or `null`; a `seq` is never
truncated. Op payloads keep history names; output keys equal SQL
column names, `id` is `local_id`. Ordinary result <= 4 KB, list record
<= 400 chars, a cut says `more=N`/`cut=N` and names the exact
retrieval command. Whole pinned brief, report and verdict are exempt
from the cap (they are the content). Text record: escaped, one record
per line; the exemption allows no multiline framing. NDJSON only for
explicitly streaming logs; `mu wait` is one object.

**Wait.** One `mu wait` over refs the caller owns. Default **first**
event (`--first-of` alias); `--all` / `--all-of` keeps the all-of
completion loop. Result `data`: `event` (alias `firing`: `kind`, `ref`,
`incarnation`, `runs`), `exit`, `snapshots`, `resume`, `timedOut`,
`cursor`. Event kinds: `closed settled input dead stall delegate
pane-exit exited pane-text heartbeat interrupted`. `exited` is a remote
command gate's own numeric status (`exit` is that code, 23 stays 23; under
`--all` the first nonzero). Timeout is `ok:true` with `timedOut`
and exit 0; dead 6, stall 7, interrupt 130. Heartbeat cap 1500 s.
`--until-idle`, `--until-text <re>` (bounded RegExp over authoritative
ctl `lastText` or the task report, never pane text for a settle; an agent
with no answering ctl socket matches its pane tail and ends the wait as the
distinct `pane-text` event, never `settled`; invalid or oversized rejects), `--status`, `--stuck-after`, `--on-stall exit|steer|release`
(steer and release only on `auto` tasks on this `dispatch_host`;
release reopens, never closes). SIGINT/SIGTERM emit one final snapshot;
**SIGKILL cannot, and no output is promised.** Unknown is never idle.
`send --wait` / `claim --for <w> --and-wait` enter the wait (one JSON document, the producer's
receipt as `data.sent` / `data.claimed`); spawn, send and claim arm a registered wait from real
state, not shell parsing (`v_wait_arming`: `src/cli/wait-arm.ts`).

**Delegates.** Every `mu_delegate` call is a `kind=delegate` task in the
caller's workstream or `scratch`, with durable `call_id`, optional
`wave`, and states `queued starting running recording done failed
refused cancelled`. A refusal past the cap is recorded and reissuable,
never dropped. The verdict is written to the judged task before the
delegate's report and close. The full multi-line evidence stays on the
judged task; the answer is the delegate task's report. Pi echo is
optional, one summary per wave. Admission control, arriving-answer
safety and `murmur:pending {source,count}` are unchanged.

**CLOSE block.** Final lines of a settled pi run's `lastText`, `task=`
the agent's own task; applied once per (agent, incarnation, runs) as
report + close in one op group; malformed writes "no close (malformed)".
`mu task close` stays. No automatic human decisions: the loop stops
only for a caller-scoped human-needed task or when nothing it owns runs.

**Budgets (pinned by tests).** SKILL 600 words, each recipe 250, all
recipes 4,000 (`test/prose-budget.test.ts`; the remote recipe's separate
200-word target is not met and not tested: it is 239); per-verb `--help` description at most 3 lines at 80 columns
(`test/help-budget.test.ts`); each `next` and error one line
(`src/messages.ts`). They do not cap canonical docs such as this page.

## Where each part lives

Every shipped unit has its modules in the
[ARCHITECTURE module map](../ARCHITECTURE.md#module-map) and its what-and-why
in the [CHANGELOG](../../CHANGELOG.md) (unit ids such as `v_wait_surface`
appear in both). Machine-local tables (`spawn_receipts`, `host_channels`,
`human_needs`, `wait_registrations`, `wait_resumes`, `wait_action_receipts`,
`remote_recovery`, and the older `delegate_calls`, `wait_cursors`,
`agent_settles`, `host_profiles`, `task_auto`, `worktrees`) are classified in
`MACHINE_LOCAL_TABLES` (`src/db.ts`); `test/entities.test.ts` fails on an
unclassified one. The build-time ownership table and reconciliation notes
are in git history.
