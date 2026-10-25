# mu-next surface contract and ownership

Status: **planned, except where a row says shipped.** This page is the
compact contract the `v_*` units build against, copied from their briefs
and the binding amendments on them. It adds no design. The design of
record is [README.md](README.md); terms are in
[VOCABULARY](../VOCABULARY.md#planned-terms-mu-next-not-shipped);
shipped behaviour is in [ARCHITECTURE](../ARCHITECTURE.md) and
[CHANGELOG](../../CHANGELOG.md). Where this page and shipped source
disagree, the source describes today and this page describes the target.

Rules for readers and for the units below:

- A unit that ships a contract moves its rows out of this page into
  ARCHITECTURE (module map) and VOCABULARY (term, no "planned" label)
  in the same commit as the code. `v_docs_final` checks nothing is left.
- No module-map row, runnable guide snippet or `Next:` hint exists for
  code that has not shipped.
- No import and no flag day (user decision, 2026-10-25): mu-next runs
  beside 3.x with its own DB, state, sync dir and machine id; workstreams
  move by `v_move_recipe`. Reading v1 segment lines and accepting a v12
  DB are no longer required (the code stays).
- The build-time spelling tournaments (`dec_*`) were dropped. The
  README Interface defaults plus the amendments below are the contract;
  `v_eval_next` measures it with grammar-neutral judges.

## Where the kernel is today (shipped)

Schema v12, `CAPTURE_VERSION` 4, 15 classified tables plus SQLite's
`sqlite_sequence`. Shipped: persistent capture triggers, local-write
guards, `NOTE_KINDS`, `tasks.scored`, `tasks.dispatch_host`,
`task_auto`, `agents.cwd/base/command/command_source`, `worktrees`,
soft teardown with a preview revision, ctl `msgId`/incarnation/`runs`,
`mu agent check`, per-line segment versions, the `MuxBackend` seam
(`spawnAgent(opts: SpawnAgentPaneOptions)`). Not shipped: everything in
the tables below. Today `mu wait --json` exits 2 (the `task` aliases, batch add, `--blocks`, `--report` and note kinds shipped with `v_task_mutations`), JSON
errors go to stdout in the envelope (shipped; `next` is always null, the legacy `nextSteps` ride beside it), `task wait` is a
separate all-of wait whose timeout exits 5, and delegate answers arrive
as pi follow-ups.

## Fixed contract (planned)

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
pane-exit heartbeat interrupted`. Timeout is `ok:true` with `timedOut`
and exit 0; dead 6, stall 7, interrupt 130. Heartbeat cap 1500 s.
`--until-idle`, `--until-text <re>` (bounded RegExp over authoritative
ctl `lastText` or the task report, never pane text; invalid or oversized
rejects), `--status`, `--stuck-after`, `--on-stall exit|steer|release`
(steer and release only on `auto` tasks on this `dispatch_host`;
release reopens, never closes). SIGINT/SIGTERM emit one final snapshot;
**SIGKILL cannot, and no output is promised.** Unknown is never idle.
`dispatch --wait` / `claim --and-wait` enter the wait; spawn, send and
claim arm a registered wait from real state, not shell parsing.

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

**Budgets (targets owned by `v_skill` and `v_docs_final`; not met by any
shipped prose yet).** SKILL <= 600 words; each recipe <= 250; all
recipes <= 4000; remote recipe <= 200; each `Next`/error one line;
per-verb help <= 3 descriptive lines. They do not cap canonical docs
such as this page.

## Ownership inventory

| Unit | Delivers | Key names |
| --- | --- | --- |
| `v_output_core` (**shipped**; see [ARCHITECTURE](../ARCHITECTURE.md)) | envelope, stdout errors, `capRecords` primitive, extension envelope consumers. Left: `next` plans (`v_hints`), text records and cap enforcement for the other readers (`state`, `log`; notes and the task reads shipped), wait `data.exit`/timeout exit (`v_wait_core`), test migration (`v_output_tests`) | `src/output-contract.ts`: `Envelope<T>`, `NextPlan`, `encodeEnvelope`, `capRecords` |
| `v_loop_storage` | schema 13: `tasks.kind/wave`; `agents.spawner/host/collected_head`; local tables | `delegate_calls`, `wait_cursors`, `agent_settles`, `host_profiles` |
| `v_agent_surface` (**shipped**, part A) | SQL-keyed agent JSON, outside-tmux attach, `spawn --task` brief | `src/agent-output.ts` |
| `v_spawn_receipts` (**shipped**, part B) | task-bound spawn: journaled reserve, spawn, claim, send; replay | `spawn_receipts`, `spawnForTask`, `attempt_key` (`manual:<k>`), `SendOptions.msgId`, `claimTask.expectedAgentId`, `releaseTask.expectedOwnerId` |
| _unassigned_ (own units, blocked on B where they use its writer) | `buildTaskBrief`, `task_auto.last_spawn` attempts, batch grammar | `buildTaskBrief(db,ws,id,identity)` |
| `v_wait_reg` (**shipped**; slice A of `v_wait_core`) | machine-local `wait_registrations`, `registerOwnedWait`/`beginWait`/`endWait`, the one typed agent observation. `v_agent_surface` never shipped the table. Arming from spawn/send/claim is `v_wait_cli`'s | `src/wait-registration.ts`, `src/agents/observe.ts`: `AgentObservation`, `watchAgentRun`, `settledCloseInput` |
| `v_task_mutations`, `v_notes` (**notes view shipped**: `task notes`/`show`, see CHANGELOG) | aliases, report writers, pinned note view | `selectTaskNotes(db,id,opts)`, `kind` assignment at insert |
| `v_close_apply` | CLOSE parse and exactly-once apply | `src/close-block.ts`: `parseCloseBlock`, `applySettledClose` |
| `v_wait_core`, `v_wait_cli` | unified wait engine and CLI, signal snapshots | `src/wait.ts`: `waitForEvents`, `WaitRef`, `WaitEvent`, `WaitResult`; `wireWaitCommand` |
| `v_auto`, `v_executor`, `v_hints` | authorisation, bounded executor, one hint source | `authorizeTasks`, `authorisedReady`, `executeNext`, `computeNext` |
| `v_delegate` (part A shipped: SDK, `mu delegates`, extension on the mux path; the mux-free path is `v_delegate_nomux`), `v_settle`, `v_human` | durable delegates, every-settle waiting, human stop | `verdictTally`, `listDelegates`; state-armed settle hook; `recordHumanNeeded`, `openHumanNeeds`, `human_needs` |
| `v_guards` (**shipped**: task side and agent side, see [ARCHITECTURE](../ARCHITECTURE.md)) | revision fences on task/agent mutations | `taskRevision`, `agentRevision` (derived, no column), `assertRevision`, `AgentRow.incarnation`, `withAgentLock` |
| `v_scope`, `v_state_log`, `v_db` | explicit `-w`, compact reads, in-process `mu db` | `installScopedViews`, `cmdDbQuery` |
| `v_task_reads` (**shipped**; see [ARCHITECTURE](../ARCHITECTURE.md) and CHANGELOG) | task list/next/owned-by/show/tree as capped records, SQL-keyed JSON items, the open-DAG frontier | `src/cli/tasks/records.ts`: `taskToOutput`, `taskRecord`, `taskPage`; `src/dag.ts`: `loadOpenTaskFrontier` |
| `v_host_profiles`, `v_remote_spawn`, `v_remote_collect` | ssh-free host templates, remote spawn and collect | `expandHostTemplate`, `withHostChannel`, `host_channels`, `ensureRemoteForward`, `collectRemoteAgent`, `closeRemoteWorktree` |
| `v_pi_package`, `v_dashboard_*` | pi package (no `mu link`), four-tab read-only dashboard | `loadDashboard`, `DashboardSnapshot`, `runDashboard` |
| `v_move_recipe`, `v_dogfood` | model-run move of one workstream from the read-only 3.x DB (≤ 250-word recipe), isolated dogfood; no import, no flag day | none (a recipe over `sqlite3 -readonly` and batch `task add --blocks`) |
| `v_skill`, `v_docs_final`, `v_eval_next` | prose budgets and markers, final docs and help budgets, measurement | `test/prose-budget.test.ts`, `test/help-budget.test.ts` |

Later additive local tables: `spawn_receipts` (`v_spawn_receipts`),
`host_channels` (`v_host_profiles`), `human_needs` (`v_human`),
`wait_registrations` (`v_wait_reg`), `remote_recovery` (`v_remote_recovery`,
storage and deleters; `agent close` / `agent collect` read it back, `v_remote_recovery_close`).

## Reconciliation inventory

What this unit changed, and what stays for later owners.

- Reworded as current vs planned: delegates (a task per call since `v_delegate` part A), `lastText`
  (only `mu_delegate` `record` parses it today; applying a CLOSE block is planned), role (advisory), release (reopens
  IN_PROGRESS), dispatch host, revision, remote metadata (`REMOTE:`
  notes today).
- Removed: card, popup, toast, tick, help overlay, footer,
  glanceable/drill-down (retired with the card TUI). Kept: track and
  diamond merge while `src/tracks.ts` ships.
- README: reaper never deletes a remote worktree; capture wording
  (`schema_version.capture_version`, outermost `BEGIN IMMEDIATE`);
  `spawnAgent(opts)` signature; fixed bugs removed from Open.
- CHANGELOG Unreleased consolidated (duplicate sections and baseline
  entries merged, obsolete `--yes`, `VcsBackend`, `freedWorktrees` and
  `failedWorktrees` wording fixed; decorative delegate footer and failed
  pruning recorded as removed).
- Left to `v_docs_final`: `docs/guide/delegate.md` display claims
  (footer counts, failed count; tracked as `rv5f_footer_docs_stale`),
  guide snippets, help budgets. Left to `v_skill`: all skill prose.
  Passing `test/doc-links.test.ts` and `test/docs-cli-drift.test.ts`
  proves links and flag names, not that a sentence is still true.
