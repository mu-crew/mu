# rr report: SLICE r7 (code comments)

Tree: /var/tmp/rr @ a0872c7 (mu-next RC). Read-only. Scratch: /var/tmp/r7 (removed).

## Scope covered
- Module header comments of every file in src/*.ts, src/{agents,tasks,cli,cli/tasks,cli/tui,ctl,mux,vcs}/*, extension/*.ts, tools/eval/*.ts.
- Sweeps over all comments in src/ extension/ tools/eval:
  - TODO/FIXME/XXX/HACK: none (the one `\uXXXX` match is a JSON escape).
  - Reverted designs from today (alsoFiring, consumeReadReport/read-delivers, pane-env/MU_PANE_ENV,
    triage_dfs_wait_owned_drain): no residue. Checked by diffing each revert against its commit
    (c1001da, 539749e, 23b2afe are exact reverts; b2ff889 is reverted along with 539749e) and grepping.
    `paneEnv` in spawn.ts is the older env map, not the reverted feature.
  - 3.x paths (src/tasks/wait.ts, src/agents/wait.ts, workspaces/vcs_workspaces, nextSteps, codecs):
    only in eval scenario comments (filed) and sandbox.ts (explicitly marked 3.x, fine).
  - Every path-like ref (docs/…, src/…, test/…) checked for existence; every `§ section` / "Section"
    doc ref checked against headings / VOCABULARY rows. All resolve except docs/mu-next/* (filed).
  - Every camelCase / CONST identifier named in comments checked for a non-comment definition;
    zero-hit ones reviewed (filed where the comment presents them as live).
  - Every `mu <verb>` named in comments checked against `mu --help` (mu init, mu tracks: filed).
  - First-person / chatty comments.
  - Comment-vs-code claims on exit codes, checked with a built mu on a private DB.

## Findings (10 tasks, all OPEN; this 3.13.3 mu has no `task triage`)
P2
- rr_r7_logs_shim_deprecated: src/logs.ts header says it is a @deprecated v9 shim to be replaced by
  v2-log-verb. It is the live log module (15 importers).
- rr_r7_agent_logs_refs: `task claim --help` (wire.ts:526) and 9 comments say the --self actor goes to
  agent_logs.source. That table was dropped in v9; the actor is in ops.actor.
- rr_r7_wait_exit5_timeout: cli/tasks/claim.ts:7-8 says task wait exits 5 on timeout.
  Repro: the timeout returns ok:true with timedOut, exit 0. agents.ts and handle.ts comments
  say agent wait "mirrors" this.
- rr_r7_dead_symbol_refs: comments refer to removed symbols/files as current: applyNotePut, loadFullDag,
  inlineNext, detectBackend in src/vcs/index.ts, src/vcs.ts, `mu tracks`.
- rr_r7_db_header_v12: db.ts header and the CURRENT_SCHEMA banner describe a v12, 15-table schema;
  the code is v13 with 26 tables. agents.ts:162 mentions "rows older than v12", which can no longer be opened.
- rr_r7_mu_next_doc_refs: next-hints.ts and cold-report.ts point into docs/mu-next/*, which release_cleanup
  folds. "give mu-next its own dir" appears in a shipped error. Other comments still say "mu-next".
P3
- rr_r7_tmux_hub_stale: src/tmux.ts says "12 src modules" import it and cites the mux-callsite-migration
  task. Actual: 2 src importers, and the task does not exist.
- rr_r7_eval_3x_paths: worktree_reuse.ts cites src/vcs/git.ts:222-236 and src/workspace/crud.ts. Those
  are v3.13.3 lines/files, and the comment doesn't say so.
- rr_r7_mu_init_refs: workstream.ts header, plus 3 more comments, refer to `mu init` and "0.1.0 ships".
- rr_r7_p3_batch: chatty "wait, I did" aside (cli/agents.ts:252); agents.ts header "CLI in step 7 will
  wrap"; @deprecated currentSessionName that is still used; "27" UsageError sites (actual 105);
  OUTPUT_LABELS_AUDIT ref; "the README's" shape; optional sweep of 71 tracker-id provenance comments.

Not re-filed (already open): rr_r1_p3_batch covers apply.ts/rebuild.ts TEMP op_ctx and db.ts:944-953
mutable names.

## Not covered
- Comment correctness inside long function bodies was sampled, not read line by line
  (wait.ts, spawn.ts, delegate.ts, nudge.ts, segments.ts > 1000 LOC each).
- test/** comments (out of scope); tools/eval/scenarios/*.ts beyond headers and path refs.
- Whether `agent wait` exit 5 vs `mu wait` exit 0 is the intended behaviour (filed as a comment fix only).
- Whether src/tracks.ts / getParallelTracks is dead SDK surface (noted in rr_r7_dead_symbol_refs).
