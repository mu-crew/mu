# rr-report R4 (cli-surface)

Tree: /var/tmp/rr @ a0872c7 (mu-next RC). Built with `npm ci && npm run build`. All runs
used a private DB/state dir (/var/tmp/r4), `MU_SYNC_DIR=` and a private tmux socket
(`MU_TMUX_SOCKET=r4sock`). The scratch dir and socket are removed.

## Scope covered
- src/output.ts and src/output-contract.ts: envelope encode, isJsonMode argv sniffing,
  usageLines (3-line JSON usage), paging fields {items,count,more,retrieve}
- src/cli/handle.ts: classifyError exit lanes, emitError (human vs JSON), the unknown-verb
  did-you-mean, quotingHint, finalNext/fitNext
- src/messages.ts: checked every key for a caller (none unused), audited the wording
- src/next-hints.ts: computeNext/capPlan/renderPlan contract read against tests
  (test/next-hints.test.ts). The `next` lines I saw ran as printed (delete/teardown --if)
- src/cli/tasks/* and src/tasks/*: add/list/next/show/notes/note/close/claim/park/
  release/block/reparent/update/delete, run live, in JSON and human mode
- help budget: test/help-budget.test.ts passes (76/76); read root, task, state and next help
- aliases: `agent stop` (alias of close) and did-you-mean (tasks, shwo, lst, tsk, statee,
  agnet, sotp, ls)
- exit codes compared with docs/guide/sql.md:42 and the handle.ts header

## What works well
- One JSON document on stdout for failures too; candidate_ids on a wrong task id;
  `usage` capped at 3 lines; the 4 KB cap with `more` + `retrieve` holds
  (task list --json = 3917 B).
- The did-you-mean verb hint and the apostrophe/heredoc hint on excess args are good.
- Each fenced preview prints an executable `next` (`--if <rev>`).

## Findings (11 tasks, workstream next-build, all OPEN; this mu has no `task triage`)
P2:
- rr_r4_unknown_ws_reads_silent: `task list/next`, `agent list` and `log` with a typo'd -w return
  an empty ok (exit 0); `state` and `db query` give exit 3; `task add` auto-creates the workstream
- rr_r4_ws_mismatch_before_resolve: wrong -w gives "conflict ... not <ws>" (exit 4) with no fix;
  the scope assert runs before name validation (-w Bad.Name gets past the name check)
- rr_r4_task_add_json_camel: `task add --json` data.task is camelCase (name/effortDays/roi),
  which breaks the contract in sql.md:17
- rr_r4_report_set_once: `--report` help says "set once, never edited"; repeats append
  and the earlier reports vanish from the default view
- rr_r4_claim_no_agent_plain_error: claim with no identity gives exit 1 with
  "claimTask: ... opts.agentName"; the SDK name leaks into CLI messages
- rr_r4_delegates_show_exit2: unknown call id gives UsageError exit 2, not exit 3
- rr_r4_close_reason_exit_split: a missing close reason exits 2 (no --evidence) or
  4 (--as X without --why, and the sql guard), with different error classes
- rr_r4_next_status_filter_noop: `task next --status/--substate` lists values the
  ready view can never match
- rr_r4_json_message_multiline: the JSON `message` carries commander's "\n(Did you mean ...)";
  the wire-matrix test misses it (it checks stdout lines, not the message)
- rr_r4_usage_help_dump_fix_named: errors that already name the fix still dump the
  full --help; db backup exits 2 where the same collision in rebuild exits 4; the ws-name error runs 290 chars
P3:
- rr_r4_p3_batch: 8-item checklist (garbled output.ts comment, a stale "globally unique"
  comment, the messages.ts "ONE place" claim (~76 inline literals), task list help
  columns, sql.md exit table missing 1, `ls` alias, exports used only in their own file,
  bare `mu task --json`)

## Not covered
- src/cli/tui (excluded); agents/wait/host/sync verbs beyond their error lanes
  (other slices cover them)
- computeNext under live owed waits and claimed-for flows (read the unit tests only;
  no agents spawned)
- herdr backend; remote hosts; human-needed stop semantics beyond one call
- Full `npm test` (ran only help-budget); no mutation check of tests
