# R6 review: tests (mu 4.0 RC a0872c7)

## Scope covered
- All of test/** (318 entries, 308 test files incl. test/eval) and the tools/eval tests under test/eval.
- Harness: vitest.config.ts, vitest.fast.config.ts, test/_setup.ts, test/_global-teardown.ts, test/_mux.ts, test/_teardown.ts.
- docs/test-health (both reports) and the AGENTS.md gate table.
- Kernel section of docs/mu-next/README.md (lines 234-327): each guarantee mapped to a test.

## What I ran (scratch copy /var/tmp/r6/w, private TMUX_TMPDIR, isolated MU_* env)
- Full `vitest run`: 5821 tests, 0 failed, 3 skipped, 307 s wall (box shared with other reviewers).
- `test:fast`: 4850 tests, 22.5 s. typecheck 1.5 s, lint 0.9 s. Two more fast runs with 14 busy loops: 0 failures.
- `unset TMUX` + integration tier: 46 skipped instead of 3. The 5 TMUX-gated files with the gate forced to true: 26/26 pass.
- Flake: agent-guards-race "staged spawn" with 12 busy loops: 2/15 pass. With a one-line poll fix: 12/12 pass.
- cli-log-tail backpressure test under load: 8/8 pass.
- Scans: .skip/.only/.todo, tests with no assertion, vi.mock and toHaveBeenCalled counts, source-grep tests, duplicate titles across files, sleeps of 100 ms or more, leftover /tmp state.

## Kernel guarantee → test map (summary; full list in rr_r6_kernel_testmap_stale)
Proven: claim CAS, close needs evidence, close refuses open blockers, reclassify to done (local-guards:89-317); ingest never blocked (local-guards:319); natural keys and OR REPLACE (capture:620+); ready order (schema-v12:231, cli-task-scored:56); soft teardown and init reuse (workstream-soft-teardown, workstream.integration:321); teardown kills first (workstream-teardown-empty:305, -probe:68); spawn claim after pane and release on rollback (spawn-ctl:866/926, spawn-receipts:379-412); incarnation mismatch (extension-mu-pi:639-656); delivery unknown, never resend (agent-transport:252); ctl served ops and /reload (ctl-client:174, doctor-ctl:274, agent-transport:546-561); close refuses dirty, --discard, unmerged commits kept on a branch, detached HEAD, --from (worktree.integration:96-368); cycle guard (tasks-crud:257, cli-task-add-blocked-by:272); task wait timedOut/6/7/warn (cli-task-wait*); tree caps (task-read-records:502-600); mu db fk/busy/views/BEGIN/did-you-mean/--shell read-only (db-query, sql-capture, db-shell); sync contract incl. flush on error (sync-contract:85-160); sync-dir refusal (sync-dir-guard, cli-doctor-exit:74); doctor cycles, drift, checksum, sqlite version, network mount, case collisions; herdr command-override refusal (mux-herdr-spawn:607); delegate admission and no-recursion (extension-delegate:345-410, :63).
Gaps: doctor "integrity" (not implemented, no test) and the doctor db block; briefs-never-cd and refresh-must-fetch (prose only).

## Findings (7 tasks, all OPEN/triage in next-build)
- rr_r6_guards_race_flake: P2. The flaky test polls the agent row, not the worktree, so it races its own `git worktree add`. Repro 13/15 failures; fix verified.
- rr_r6_tmux_gate_env: P2. 43 real-tmux tests skip silently without $TMUX, although they run on the private socket.
- rr_r6_doctor_integrity_gap: P2. The README promises doctor integrity; doctor runs no integrity/quick_check, and the db block has no test.
- rr_r6_kernel_testmap_stale: P2. The README verb table cites nonexistent or wrong test files.
- rr_r6_test_tmp_leaks: P2. One /tmp/mu-test-xdg-* dir leaks per fork (11,209 on this box), plus every socket file and the private servers of interrupted runs.
- rr_r6_next_mock_dup: P3. The same vi.mock factories are copied across 4 next/spawn test files.
- rr_r6_p3_batch: P3 checklist: stale vitest comments; AGENTS.md "Today" numbers (slow tier now over the 5-min budget); cold-guess liveness follow-up never done; source-grep test in pi-package; permanent reftable skip; weak doctor --json assertion; test/README scope.

## Checked and fine (not filed)
- No .only/.todo; the only skips are environment gates (herdr, lsof, built dist, git reftable).
- Mocking is moderate: the vi.mock users keep real SQLite and fake only spawn/transport; the toHaveBeenCalled calls check pi side effects (sendMessage, abort). That is the behaviour under test.
- Assertion-free tests are TUI tests that assert through `ui.until(...)` (waits on screen text). Acceptable.
- Duplicate titles across files: 5, each in a different context; not real duplicates.
- Source-reading tests in index-exports-errors and log-render are coverage guards over src lists. They serve a purpose.

## Not covered
- herdr real-server tests (no herdr on this box); remote-host tests against a real ssh host.
- Per-test review of all ~5800 assertions. I sampled by grep patterns and the kernel map, not line by line.
- Stress beyond the targeted loops: no `npm run test:stress` 30-run soak.
- The surface/TUI/dashboard test semantics beyond the scans (other slices).
