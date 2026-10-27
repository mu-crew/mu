# R5 (TUI + dashboard data) review report

Tree: /var/tmp/rr @ a0872c7 (mu-next RC). Read-only; scratch in /var/tmp/r5 (removed), private tmux socket `-L r5`.
Task ids are lowercase `rr_r5_*`: mu rejects uppercase ids (`/^[a-z][a-z0-9_-]{0,63}$/`). All filed as OPEN/triage via `task add --triage`.

## Scope covered
src/cli/tui/{app,overview,rows,drill,frame,grid,columns,theme,text,nav,commands,runtime,use-snapshot,index}.ts(x),
src/dashboard-data.ts, src/cli/dashboard-launch.ts, plus the related tests (dashboard-*.test.ts, tui-*.test.ts).

## What I checked
- Read every file in scope in full.
- Ran the 11 dashboard/tui test files: 194/194 pass.
- Ran built `mu` (bare, TTY) in a private tmux against a seeded DB (20 ws x 150 tasks x 3 notes) and a small one (4 x 30):
  - idle CPU at the 1 s tick: 12% of a core (big), 2% (small)
  - loadDashboard timings by component (frontier dominates)
  - tiny terminals (40x6, 20x3, 10x2, 5x1, 80x4): layout degrades as documented; never wraps; footer pinned
  - NO_COLOR=1: captured SGR codes are only bold/dim/inverse/reset, no colour (OK)
  - theme literal leaks: grep for colour names/ANSI outside theme.ts finds none (OK)
  - tab/status filter interplay, teardown of the selected workstream, filter editing
- Copy commands (`mu log --all --since N-1 -n 1`, `mu task show`) give the right row.
- Dead exports/usages, duplicate helpers.

## Findings
| id | sev | summary |
|---|---|---|
| rr_r5_overview_follows_tasks_filter | P1 | The Tasks status filter is the shared query. With it on `closed`, the Overview cards show "nothing open"/"nothing in progress", and human-attention items lose their drill |
| rr_r5_idle_cpu_all_ws_reads | P2 | Each 1 s tick loads tasks and frontier for every live ws (115 ms vs 29 ms scoped) and stringifies the 1.5 MB snapshot: ~12% idle CPU |
| rr_r5_torn_down_ws_stale_chosen | P2 | After the selected ws is torn down, the row moves to another ws but the query keeps the dead one. Log stays at 0 rows |
| rr_r5_sync_warnings_flash | P2 | The runtime never passes syncWarnings, so `sync` attention can't happen. The footer warning lasts one tick. Docs claim attention covers it |
| rr_r5_dead_exports | P3 | workstreamLine (no callers), renderRow/frameLines/frameParts/columnWidths total (test-only), Row.notice (never read), over-exported symbols |
| rr_r5_dup_helpers | P3 | statusText/taskLine/formatPair, textMatch/matches, scrollback target built twice, ago vs formatElapsed |
| rr_r5_ws_row_cuts_selected | P3 | Workstream-row scroll doesn't count the "…" prefix, so the selected label gets cut |
| rr_r5_p3_batch | P3 | Stale comments: app.tsx header, AttentionKind order, sync.ts "Doctor card", logWorkstream "live" claim, columns.ts |

Totals: 8 tasks (P1 1, P2 3, P3 4).

## Notes (checked, not filed)
- Flicker guard A/B works: an unchanged tick renders nothing (covered by a test).
- Runtime single-flight and query-ordered serialisation look right.
- Attach suspends/resumes the terminal, drains typeahead, and falls back to scrollback.
- use-snapshot: the `changed || slow` path with `!changed` keeps the old snapshot reference. Correct but convoluted. Not filed.
- Tests lean on `as never` partial snapshots (dashboard-tabs.test.ts, ~11). Acceptable for pure row functions; not filed.

## Not covered
- Real agent states (busy/permission/dead/stalled) against live pi agents. Only the code path and unit tests were checked.
- herdr backend attach. Attach was not run end to end (needs a real mu session).
- Drill scrollback capture against a live pane. The OSC 52 yank was not checked in a real terminal.
- Wide/CJK glyph rendering was checked only by reading the code (string-width used throughout).
