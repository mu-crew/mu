# R3 — agents / mux / remote pre-release review

Review tree: `/var/tmp/rr`, HEAD `a0872c7`.
Repo read-only: no tracked edits, no commits; `git diff --exit-code` and status clean.

## Scope checked
- Agent spawn/staging/rollback, task-bound receipts and replay, close/preview/locks/reaper.
- Send/fresh/interrupt/session commands, ctl client/protocol, observation paths.
- tmux topology/liveness/retained panes; herdr spawn/prompt/close implementations.
- Host profiles/channel admission, remote preparation/close/collect/recovery.
- Local worktree creation, preservation, reuse, cleanup/retry; non-pi CLI paths/docs.
- Code-reviewer lens: lifecycle duplication, unenforced comments, rerunnability,
  mocked tests that omit real asynchronous identity and resource-failure seams.

## Verification
- `npm ci && npm run build`: exit 0.
- Focused existing unit suites: 13 files, 340 passed.
- Existing git/local-remote integration suites: 3 files, 123 passed, 1 skipped.
- Existing private-tmux suites: 3 files, 17 passed.
- Total: 480 passed, 1 skipped (unsupported optional integration case).
- Used scratch vitest config without default-socket global setup/sweep.
- Private tmux socket only; its server was killed afterward.
- Built execution used isolated MU_DB_PATH/MU_STATE_DIR and blank MU_SYNC_DIR.
- Deterministic SDK/SQLite/real-socket/real-git reproductions exposed the findings
  below despite the existing focused suites passing. Evidence is in task notes.
- OPEN tracker checked before filing: no duplicate finding titles.

## Findings filed in installed mu 3.13.3, workstream next-build
| Severity | Task | Finding |
|---|---|---|
| P1 | rr_r3_send_unbound_incarnation | Ordinary send/fresh fail to fence hello incarnation |
| P1 | rr_r3_interrupt_unbound_incarnation | Interrupt can abort/send to replacement pi |
| P1 | rr_r3_session_ignores_fence | Session commands ignore explicit incarnation fence |
| P1 | rr_r3_close_unknown_probe | Unknown pane-death proof permits destructive close |
| P1 | rr_r3_local_close_no_quiescence | Local worktree removed under detached writer |
| P1 | rr_r3_local_rollback_live_pane | Local rollback deletes worktree/row of surviving pane |
| P1 | rr_r3_task_send_after_close | Task closes during hello; task-bound prompt still sent |
| P1 | rr_r3_remote_prepare_orphan | Lost prepare answer leaves untracked remote worktree |
| P2 | rr_r3_branch_retry_collision | Cleanup retry collides with its own preserved branch |
| P2 | rr_r3_spawn_stale_profile | Spawn ignores admission's current profile snapshot |
| P1 | rr_r3_remote_auto_closes | Remote CLOSE report automatically closes owned task |

Requested `rr_R3_*` IDs were rejected by installed lowercase-only task validator;
used `rr_r3_*`, retaining `SLICE: R3` in every note. No `task triage` verb exists:
all 11 findings remain OPEN/todo for orchestrator triage. P3: none.

## Not covered / limits
- No live external host/SSH/hardware-key, actual herdr server, or real codex/cursor login.
- No full-suite/stress gate, release packaging audit, or exhaustive extension audit.
- No independent delegate/refuter tool available; findings rely on executed evidence.
- Remote tests use local command-template fixtures; ctl race repros use real Unix sockets.
- Temporary repro scripts, fixtures, logs, and known-task snapshots removed after review;
  permanent source quotes and observed results remain in tracker notes.
