# R2 — wait/delivery pre-release review

Tree: `/var/tmp/rr`, release candidate `a0872c7`; read-only review.

## Scope covered
- `src/wait*.ts`: engine selection/commit, latches, cursors, registration,
  producer fences, owned/done marks, dead-event folding, stalls/actions,
  regex bounds and resume storage.
- `src/cli/wait*.ts`: parsing, arming, result shaping and resume construction.
- `src/delegates.ts`, `src/delegate-process.ts`: recorder and process lifecycle.
- `extension/nudge.ts`, `extension/delegate.ts`, `extension/mu-run.ts`:
  settle, wave batching, wakes, cancellation/reload and subprocess plumbing.
- Relevant existing tests; reverted designs 1fb4856, 34fa5e1, 956da3e.
- Murmur pending consumer at `crew/murmur/src/extension/murmur-pi.ts:508-523`
  and `extension/decide.ts:73-101`. Payload remains `{source,count}` on
  `murmur:pending`; no payload incompatibility found.

## Checks and evidence
- Requested known-task snapshot was truncated at 200000 bytes; skimmed it,
  then parsed a fresh complete installed `mu task list` stream for OPEN titles.
  No matching OPEN finding existed when filing.
- `npm ci && npm run build`: passed in review tree.
- Targeted unit run: **28 files, 678 tests passed**, exit 0.
  Scratch vitest config omitted default global setup/teardown (these touch
  the default tmux server); retained per-test environment/DB setup.
- Five deterministic scratch regressions failed on real production functions:
  two urgent resume cases, same-ref rearm, refused-only wait, consumed wave
  sibling with unrelated pending work. Shared-caller hypothesis was discarded:
  normal producers intentionally arm only one identity.
- Built SDK independently reproduced same-ref rearm loss; built CLI reproduced
  refused heartbeat and confirmed task-notes reads remain non-consuming.
- No `alsoFiring` or `consumeReadReport` implementation remains. The latter
  survives only as false upcoming-release changelog claims.
- All executions used scratch DB/state, blank MU_SYNC_DIR, private socket
  selection; no default tmux operations were run.
- Final `git diff --exit-code` and `git status --short`: clean.

## Findings filed — 6 tasks (P1 4, P2 1, P3 1)
- **rr_r2_resume_drops_work (P1)** — urgent `--first` drops unfinished refs;
  urgent `--all` drops fired targets the event never consumed from resumes.
- **rr_r2_rearm_lost (P1)** — delivery drops a newer same-agent send's
  registration; returned run 1, registration empty despite run 2 being armed.
- **rr_r2_refused_settle_loop (P1)** — refused-only owned work produces
  heartbeat/open:1 forever; settle automatically retries without a runnable call.
- **rr_r2_wave_consumed_sibling (P1)** — batching waits for a sibling whose
  earlier event was already consumed, delaying the new report on unrelated work.
- **rr_r2_reverted_changelog (P2)** — CHANGELOG.md:74-75 promises reverted
  read-delivery, a nonexistent delivered field, and a deleted test file.
- **rr_r2_p3_batch (P3)** — stale `poke()` comment and regex comment denying
  the supported non-pi pane-text input; one checklist task.

Installed 3.x rejects uppercase IDs (`rr_R2_*`: TaskIdInvalidError), so IDs
use `rr_r2_*`; every note retains `SLICE: R2`. It has no `task triage`
subcommand. All findings are left OPEN/todo for orchestrator triage.
Task notes include locations, exact results/minimal fixture, smallest suggested
fix and effort; no fixes implemented.

## Not covered / limitations
- No live pi/model/API end-to-end runs, remote SSH execution, herdr, or real
  tmux pane/reload smoke tests. Process/transport tests used existing seams.
- No full suite, stress gate, lint/typecheck gate, or power-loss/SIGKILL testing.
- No claim that durable exactly-once holds across arbitrary output loss/crash.
- Source-helper regressions used a scratch vitest harness; harnesses, DBs and
  logs removed after filing. Reproduction details persist in tracker notes.
