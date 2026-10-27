# R1 — kernel-data pre-release review

## Scope covered
- `src/db.ts`, `src/db-recovery.ts`, `src/capture.ts`, `src/op-context.ts`.
- `src/apply.ts`, `src/fold.ts`, `src/rebuild.ts`, `src/cli/rebuild.ts`.
- `src/segments.ts`, `src/segment-line.ts`, `src/segment-manifest.ts`,
  `src/segment-resume.ts`, `src/sync.ts`, `src/sync-dir-guard.ts`.
- `src/state-dir.ts`, SQL boundary in `src/cli/db-query.ts`, CLI sync hook,
  related tests and recovery/sync/SQL contract documentation.
- Code-reviewer lens: stale constraints/comments and missing behavioral
  cases in otherwise real-SQLite tests; correctness and release invariants.

## Verification
- Built detached `/var/tmp/rr`: `npm ci --include=dev --ignore-scripts=false
  && npm run build` succeeded. Plain initial npm ci omitted dev tooling here.
- 25 targeted test files passed, **880 tests** (619 + 261), no failures.
- Ran vitest with a scratch config without repository globalSetup because
  that hook sweeps the DEFAULT tmux server. No default tmux commands run.
- All built executions used isolated MU_DB_PATH/MU_STATE_DIR and blank
  MU_SYNC_DIR, except explicit disposable sync-dir tests. No real mux needed.
- Executed SQL -> rebuild comparisons, real SQLite two-connection/child-process
  scheduled concurrency repros, JSONL framing/peer ingest repros.
- Confirmed SQL default write refusal and bookkeeping-write refusal.
- Confirmed schema-v12 refusal exit 4 with identical DB SHA-256 before/after.
- Confirmed v1 sync-dir refusal exit 4 and no target DB created.
- Git status/diff remained clean: no source edits or commits.

## Findings filed
1. **P1** `rr_r1_note_update_replay`: successful SQL note edit becomes two notes
   after rebuild, including wrong author/time on the synthetic edited note.
2. **P1** `rr_r1_note_delete_reused_key`: after note IDs change on rebuild,
   deletion can reference an unrelated historic put and resurrect the deleted note.
3. **P1** `rr_r1_multiline_json_segment`: pretty-printed JSON log text is embedded
   verbatim into JSONL, permanently stalling peers and trapping subsequent ops.
4. **P1** `rr_r1_log_clock_append_race`: clock mint and log INSERT are separate
   commits; a concurrent later append/flush permanently skips the earlier op.
5. **P1** `rr_r1_rebuild_clock_snapshot`: separate identity/log SELECTs can copy
   a stale clock with a future peer op; later edits then lose on replay/sync.
6. **P2** `rr_r1_edge_timestamp_replay`: SQL edge.created_at updates are captured
   but foldEdge restores the original timestamp on peer projection/rebuild.
7. **P3** `rr_r1_p3_batch`: grouped misleading TEMP-context and mutable-natural-key
   comments, with a follow-up correcting the precise applyOp line range.

All tasks contain WHERE/EVIDENCE/FIX/EFFORT. Concurrency tasks also contain
complete executable repro scripts in tracker notes. Checked existing OPEN titles
before filing; no duplicates found. Installed 3.x refuses uppercase task IDs,
so IDs use `rr_r1_` with `SLICE: R1` in every note. It has no task triage verb;
all seven findings remain OPEN for the orchestrator to triage.

## Not covered / limits
- Not a full release suite, stress gate, exhaustive fuzzing or power-loss test.
- No live tmux/herdr, Syncthing/network transport, remote host or pi extension run.
- Concurrency schedules forced at real SQLite call boundaries, not observed
  statistically under random load; no DB/flush/rebuild side effects mocked.
- Equal-stamp hand-edited capture triggers were tested but not filed: existing
  tests explicitly retain/report those modifications rather than auto-repair.
- No exhaustive external sqlite3 compatibility/security audit or all SDK verbs.
- Scratch `/var/tmp/r1` removed after evidence was recorded in tracker notes;
  requested `/var/tmp/known.json` and this report retained.

## Result
7 tasks: P1 5, P2 1, P3 1. Release candidate violates replay and sync guarantees.
