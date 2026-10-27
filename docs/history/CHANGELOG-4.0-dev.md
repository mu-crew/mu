# Changelog: the 4.0 development history

Everything built between 3.13.3 and 4.0.0, one entry per change, kept as written while the work
landed. [CHANGELOG.md](../../CHANGELOG.md) holds the curated 4.0.0 release notes.
Entries for behaviour that was later reverted are removed; a few entries describe intermediate
states (for example "SDK only until ...") that the shipped build supersedes. When an entry and
`mu <verb> --help` disagree, `--help` wins.


### Changed

- **One workstream rule: an unknown `-w` is exit 3 on every verb** (`rr_fix_r4_ws`; findings `rr_r4_unknown_ws_reads_silent`, `rr_r4_ws_mismatch_before_resolve`). `task list`, `task next`, `agent list` and `log` answered a typo'd `-w` with an empty success ("nothing to do"), and `task add -w nows` created the workstream `nows`. Every verb that acts inside a workstream now checks it exists (`resolveExistingWorkstream` in `src/cli.ts`, the same check `state` uses): `no such workstream: r4w (did you mean r4ws?); \`mu workstream init r4w\` creates it`, exit 3. The `init` fix is left out when the name could not be a workstream. The reserved `scratch` still auto-creates on its first `task add`, and `agent spawn` still creates its workstream (a spawn is the create path; `-w` there is the name you are choosing). `mu log` still reads a destroyed workstream's history. A task or agent verb with a wrong `-w` now validates and checks the name first (an invalid or unknown name is exit 2 or 3, no longer a scope conflict), and the exit-4 conflict ends with the fix: `task a1 is in workstream r4ws, not other; pass -w r4ws`. `editDistance` moved to the leaf `src/edit-distance.ts`. Tests: `test/cli-unknown-workstream.test.ts`, red first.

- **Dashboard: fully live, the 3.x way** (`tui_live_updates`, user request). Lists polled every 2 s and probed every agent's control socket on each poll. Drills loaded once and changed only on `r`. The 3.x mechanism (v3.13.3 `state.ts`, `task-detail.tsx`) is ported, and every view is live:
  - **One poll loop** (`use-snapshot.ts`), kept running while a drill is open. The fast tick (default 1 s, `+`/`-` live from 100 ms to 10 s) is SQL only: agent states come from the runtime's cache. The slow tick (10 s, `SLOW_TICK_MS`) re-probes every agent into that cache. `r` and a tab switch run it now. A new agent is probed once on the fast tick.
  - **Flicker guard:** a snapshot whose key matches the published one sets no state and renders nothing. The key is the visible content, with tool clocks counted in whole seconds. `nonce` moves only when the key changes.
  - **Drills:** notes re-read on `nonce`, with a live `status @owner title` line pinned under the title. Scrollback re-captures on the slow tick. A log entry shows its task's current line. A refresh keeps the previous body (no `loading…` flash) and the scroll position of the same entity. A body scrolled to its end follows new lines.
  - **Cursor:** it stays on its row's key when rows reorder. A row that leaves (closed, deleted) hands the cursor to its neighbour, not the top.
  - **React production build:** the dashboard sets `NODE_ENV=production` when it is unset. The development build was ~2x the idle CPU (profiled).

  Measured with the new `smoke.py live` (s2 driven by the CLI from a second process), latency counted from the write's return to the screen: Overview strip appears 0.47 s and clears 0.78 s; Next line 0.00 s; Tasks row add 0.42 s, close 0.89 s; DAG edge 0.11 s; Log row 0.36 s; note in an open notes drill 0.42 s; scrollback 8.4 s and agent death 9.4 s (slow tier, 10 s budget). Idle CPU on Tasks over 60 s: 1.67% of one core. Overview with two ticking tool clocks: 2.23%. s6 under the mutator: 2.13%, and an open notes drill grows with no key press. Tests: `test/dashboard-live.test.ts`.

- **Dashboard: the 3.x colour palette** (`tui_u8_colors`, user request). The dashboard was monochrome apart from a yellow strip. It now uses the 3.x TUI's colours (v3.13.3: titled-box, list-row, `inkColorForPair`, `STATUS_COLORS`, the log card, the tab strip, the drill): gray rounded frames with a bold cyan title, a dim count and a dim `+N more`; task status OPEN cyan, OPEN/parked and OPEN/triage gray, IN_PROGRESS yellow, CLOSED/done green, any other CLOSED red; ids bold, owners, hosts and times dim; agent state busy cyan, needs_permission magenta, idle and unknown dim, a dead agent red, a stalled tool yellow; the log verb cyan (operator prose stays plain); the selected workstream and tab bold cyan, the rest dim; a drill's title bold magenta; the strip's `✓ all quiet` green, its items yellow, dead ones red. The cursor row stays solid inverse with per-cell colour dropped, as 3.x's CursorRow did. Every colour is a named role in one new module, `src/cli/tui/theme.ts`, and no view names a colour. Rows now carry a styled `line` next to their plain `text`, and the text is derived from the line, so the two cannot differ. **NO_COLOR** (any value) turns every colour off and keeps bold, dim and inverse. Ink's chalk 6 does not read NO_COLOR (measured: level 3 under a PTY with `NO_COLOR=1`), so the theme checks it. **No state glyphs:** 3.x drew Nerd Font codepoints with no ASCII fallback (`src/glyphs.ts`: "Requires a Nerd Font"), so the ASCII markers stay. Tests: `test/tui-theme.test.ts` (roles, styled rows, strip, `fitLine`, SGR codes through ink with colour on and under NO_COLOR). PTY captures (`capture-pane -e`) for s2 and s4 at 200x50 and an s4 NO_COLOR capture with zero colour codes; `smoke.py` passes.

- **Dashboard: Ctrl-d/Ctrl-u and g/gg/G everywhere, hint pinned on every screen, Enter in DAG** (`tui_u9_keys_pin`, dogfood feedback 2). Every list (the tabs, the Overview's Attention cursor) and every drill body (notes, scrollback, log entry) now moves through one key map, the new `src/cli/tui/nav.ts`: j/k, Ctrl-d/Ctrl-u half a page, PgUp/PgDn, `g` (so `gg` too) top, `G` bottom. The hints read `j/k ^d/^u g/G`. A drill was as tall as its body, so opening a task with short notes pulled the hint up near the top. Every drill is now exactly the terminal's rows, with the hint on the last row. DAG rows had no drill target, so Enter did nothing; it now opens that task's notes, the same drill as Tasks. Tests: `test/dashboard-drill.test.ts` (drill pinned at 120x40 and 80x24 for notes, scrollback and log; DAG Enter; drill and list keys), red before the fix. `smoke.py drill` checks the same on s2 through real tmux. **The attention strip is on every view** (user follow-up). The Overview used to drop it, because its Attention card stood in for it, and drills had none. Now the one line (`⚠ 4 need you: …` or `✓ all quiet`) sits under the tabs on the Overview and on every tab, and under the title in every drill. The Attention card stays, since it holds the cursor. Tests: `test/dashboard-overview.test.ts`, red first. `smoke.py fill` requires the strip on row 3 of every screen (`⚠` in s4), and `smoke.py drill` requires it on row 2.

- **TUI dogfood kit, second pass** (`tui_u7_kit`, dogfood item 7; [PLAN](../mu-next/tui-dogfood/PLAN.md) U7). This is kit only, with no `src/` change. The scenario 7 workers now look different: each pane starts with a banner and prefixes every line with `remote:dev` or `local` (`fake-worker.mjs --banner`), and `worker-2` waits for input instead of running the same busy profile as `worker-1`. `FORM.md` is rewritten for the second human pass, with one section per original feedback item (viewport, sort and detach, trouble first, workstream switch, column stability, remote/local) that asks whether it is fixed, whether it is better, and what still bugs you. The README documents the Overview tab, `s` sort, `o` status and the detach hint. `smoke.py` adds `fill` (s2/s4/s5/s7 at 200x50, 120x40 and 80x24, every tab, read off a private tmux screen: the last row is the hint, every tab frame reaches the last body row, and an Overview column with `+N more` does too) and `stable` (s6 Tasks and Log: the second column starts at the same x in two screens 5 s apart). All of it passes. At 200x50 the Overview's blank rows sit only under columns with nothing hidden (s2 and s4: Attention and Agents fit; s5: Open and Log fill to the footer), so `grid.ts` is unchanged.

- **Dashboard: Overview first screen, framed full-height tabs, attention strip, pinned footer** (`tui_u6_screen`, dogfood items 1 and 4; [PLAN](../mu-next/tui-dogfood/PLAN.md) U6). The screen used 13 of 50 rows. Bare `mu` now opens on **Overview**: framed cards for the workstream (Attention over every workstream, Agents, In progress, Open by ROI, Log tail) in 1/2/3 columns at <120/120/180 cols, rows shared by `grid.ts` so a card hiding data grows and says `+N more`; j/k and Enter work on the attention items (agent scrollback or task notes). The other tabs are one frame each (tab name and count in the top border, `12/197` in the bottom) that fills the screen, with an attention strip under the tabs (`⚠ 4 need you: …`, or `✓ all quiet`). Next and the hint are pinned to the bottom rows. A short terminal drops the strip, filter and Next before the footer. New `src/cli/tui/overview.tsx`, `test/dashboard-overview.test.ts`; `smoke.py` presses one more Tab.

- **Dashboard: stable columns per tab, owner before the title, host column, `s` sorts** (`tui_u4_columns`, dogfood items 2a and 6; [PLAN](../mu-next/tui-dogfood/PLAN.md) U4). Every tab now lays its rows out with `columns.ts`, widths taken from the whole snapshot of the workstream (never the filtered or scrolled rows), so a filter or a poll cannot move a column. Tasks: id (cap 24), status (fixed at `CLOSED/superseded`), owner, then the title as the one clip column, so a long title no longer cuts the owner off. DAG: indent-carrying id, status, title and notes (the `[ ]` brackets are gone). Agents: name, host (`dev` or `local`; replaces `name@host`), state (fixed at `needs_permission`), task, tool. Log: right-aligned seq, time, text (the scope column is gone: the log is per workstream). Keys: `s` on Tasks cycles the sort activity → roi (`impact/effort_days`, ties to the smaller effort) → age (oldest first, new `DashboardTask.created_at`) → id; the status filter moved to `o`. The filter line shows `sort: roi ↓`; `c` resets sort too. Tests: `test/dashboard-tabs.test.ts`.

- **Dashboard geometry modules** (`tui_u2_geometry`, dogfood items 1 and 6; [PLAN](../mu-next/tui-dogfood/PLAN.md) U2). Pure, plain-text building blocks ported from the 3.x render rules, not yet wired into the screen: `src/cli/tui/columns.ts` (protected columns never cut, one clip column ending in `…`, widths from the rows the caller passes so a filter or poll cannot move a column), `frame.tsx` (rounded frame, title and count in the top border, `+N more` in the bottom, always exactly width x height) and `grid.ts` (1/2/3 columns at <120/120/180 cols, a fixed card placement table instead of 3.x's hysteresis, min/max row budgets whose spare rows go to the cards hiding data so a column fills its height). 48 unit tests in `test/tui-geometry.test.ts`.

- **Dashboard read model: `attention[]` and `created_at`** (`tui_u3_attention`, dogfood item 4). `loadDashboard` returns `attention`, the trouble a human must see from the first screen, over every live workstream and blind to the status, text and workstream filters: `dead` (pane gone, or a gate's process exited), `permission` (with age), `input` (the `idle` flag: `needs_input` past `MU_IDLE_THRESHOLD_MS` while owning work), `stalled` (one tool over 15 min, `STALLED_TOOL_MS`), `human` (an OPEN `kind=human` task, whoever recorded it: `human_needs` stays caller-scoped and is empty for a human shell), `next_unavailable`, and `sync` (from the new `DashboardOptions.syncWarnings`). Most urgent kind first; each item has a drill `target`. Tasks carry `created_at` for an age sort. Agents are now read for every live workstream (Attention needs them); `agents` is still narrowed by scope and text. Data only, no UI yet (U6). Tests: `test/dashboard-data.test.ts`.
- **Dashboard `a` attach says how to get back, and nests on purpose** (`tui_u5_attach`, dogfood item 2b). `$TMUX` counted as "inside" whatever server it named, so the kit (which unset it) nested blindly and only `C-b C-b d` got the human back. tmux `attachCommands` now compares `$TMUX`'s socket with `MU_TMUX_SOCKET`: same server → `switch-client` (hint `a attach (back: C-b L)`); another server → `attach-session` marked `nested`, run with `TMUX` removed (the copied line reads `env -u TMUX tmux ...`; hint `a attach (detach: C-b C-b d)`). Before the handoff the terminal gets one line: `attaching mu-x:worker-1 · detach: C-b d (nested: C-b C-b d)`. `currentSessionName` ignores a foreign `$TMUX` too. The dogfood kit keeps `$TMUX` and takes `MU_DOGFOOD_SOCKET`. Verified in real nested tmux on private sockets, both paths. Tests: `test/tmux.test.ts`, `test/dashboard-drill.test.ts`, `test/spawn-ctl.test.ts`.

- **Dashboard: Agents and Log follow the workstream switch (`[` `]`); remote agents say `@host`** (`tui_ws_switch_bug`, dogfood items 5 and 7). Both tabs listed every workstream, so cycling changed Tasks and DAG only. Every tab now shows the selected workstream; agent rows use the bare name (`worker-1`), a remote agent `worker-1@dev`, and a task of another workstream keeps its qualifier. Filters and cursors on Agents and Log are per workstream like the others. The Log tail is read per workstream (`DashboardOptions.logWorkstream`), so a quiet workstream is not pushed out of the 100-op tail by a busy one. Scenario 7 was seeded right (`worker-1` on host `dev`, `worker-2` local): the old rows had no host marker at all. Tests: `test/dashboard-tabs.test.ts`, `test/dashboard-data.test.ts`.
- **The `course check due` notice is an instruction, and SKILL.md has a bullet for it** (`course_check_ab`). The notice now reads `course check due: <n> closed since <date>. Stop dispatching: finish merging, then follow recipes/course-correct.md`; SKILL.md gains the bullet "`course check due` stops dispatch: finish merging, then course-correct to its `mu human-needed`" (555 → 569 words). Why both: on haiku ×5 the `course_check` scenario passed 0/5 on the base, 2/5 with the bullet alone, 2/5 with the notice alone, 5/5 with both (303k tokens/rep vs 593k base), and the neighbours (`wait_interrupted`, `delegate_saturation`, `refute_verdicts`) held: `delegate_saturation` and `refute_verdicts` 5/5 on every variant, `wait_interrupted` 4/5 on a, b and c against 5/5 on base (a and b missed on a fixture timing, c on one re-sent task; n=5), no destructive runs. Log: docs/mu-next/eval/hillclimb-skill.jsonl.

- **Skill: SKILL.md drops the JSON-envelope paragraph** (`t_skill` step 3, 597 → 555 words). The envelope, error document, collection and key shapes are in `--help` and each result's own `next`. R4 on haiku ×3 over 14 non-holdout scenarios: cost −470k/rep, inside the 694k rep spread, destructive 0, completed 35 → 38/42, so the shorter text wins the tie. Log: docs/mu-next/eval/hillclimb-skill.jsonl.

- **Guide: Run mu with other agent CLIs** (`dogfood_harnesses`, [docs/guide/other-agent-clis.md](../guide/other-agent-clis.md)). Pinning which `mu` a codex or cursor-agent shell runs (their tools re-source `~/.zshrc`; `codex --disable shell_snapshot`, an empty `ZDOTDIR`), a tmux worker started with its prompt as an argument, waiting on `task:` refs, delegation through `scratch`, and what works with no multiplexer. The report is [docs/mu-next/eval/harnesses.md](../mu-next/eval/harnesses.md).

- **`mu wait agent:` on a non-pi agent keeps the 3.x busy-first rule** (`triage_dfh_wait_nonpi_idle`, harnesses F4). It fires only on busy → not busy. murmur's notify path (codex, cursor-agent) reports `unknown`, then `needs_input`, and never `busy`, so on tmux the wait runs to its timeout. 3.13.3's `mu agent wait` does the same, checked against the same pane states. The guide now says so and points at `task:` refs and `--until-text`. Test: `test/wait-events.test.ts` (notify-only agent, mutation-checked).

- **Guide: wire codex to murmur through its `Stop` hook, not `notify`** (`triage_dfh_notify_stall`, harnesses F3). codex runs a hidden turn to title each new thread, and legacy `notify` reports it as `agent-turn-complete` about 2 s into the worker's first turn. murmur records `done`, so `--stuck-after` reported a running codex worker as stalled (exit 7 at 16 s of a 40 s `sleep`; 3.13.3 exits 7 on the same pane state). A `Stop` hook running `murmur notify --source codex --event-type agent-turn-complete` fires only for real turns: no stall on the same run. No engine change: the stall rule stays the 3.x one (needs_input age, from any source). Test: `test/wait-contract.test.ts` pins a murmur-sourced stall (mutation-checked).

- **`mu sql` / `mu db query` read by default; a write needs `--write`** (`sql_write_optin`; the release matrix had haiku writing raw rows). A statement SQLite reports as not read-only (INSERT, UPDATE, DELETE, REPLACE, `WITH ... INSERT`, anything with RETURNING; a script checks each statement) is refused before it runs with one line naming the verb and `--write` (UsageError, exit 2); the connection also runs `query_only` meanwhile. `--confirm-rows` needs `--write` to do anything. EXPLAIN and PRAGMA reads are unchanged. Writes under `--write` are captured exactly as before (one `sql.write` group). Help is 3 lines; the guide says so; the eval `bad-*` scripts that write now pass `--write`. Test: `test/sql-write-optin.test.ts` (each write shape, mutation-checked).

- **Cold-guess misses as aliases** (`t_surface`, one round): `mu agent stop` is an alias of
  `agent close`; `agent spawn --task <id>` without `--send` sends the task's own brief note (a
  task with no brief gets one line from its title); an unknown plural noun names its list (`mu tasks`
  → `closest: mu task list`) and a tie between namespaces prefers `task` (`mu show` → `mu task
  show`, was `mu agent show`); the `blockers` view gains `task_local_id`. Scored with R4 on
  haiku x3: docs/mu-next/eval/hillclimb-surface.jsonl.

### Test health

- **Surface milestone measurement** (`v_health`, [docs/test-health/2026-10-23-surface.md](../test-health/2026-10-23-surface.md)). Fast tier 217 files / 4720 tests and full suite 302 / 5691 (3 environmental skips), all green. Both gate budgets are over on the shared host: fast ~49 s (budget 30 s), `npm run test` 8m31s (budget 5 min). The suite doubled since the kernel milestone. Test-only speed-ups with unchanged counts: `cli-json-wire-matrix` seeds a template DB once (36 s → 3 s) and the `extension-mu-run` TERM-trap test no longer waits on its own leaked `sleep` (10 s → 0.3 s), both mutation-checked. Top-20 classified; no MERGE or DELETE. Main remaining cost: fresh `openDb` is 48% of fast-tier time (follow-up: a shared template-DB helper). `docs/ARCHITECTURE.md` gains rows for `src/cli/doctor.ts`, `src/cli/tasks/wire.ts` and `extension/delegate-process-format.ts`.
- **Shared template DB for tests** (`fast_gate_budget`). globalSetup builds one schema DB with the real `openDb`; a setup file routes every test `openDb` on a new path through a copy of it, re-keyed with its own `machine_identity`. Fast tier ~49 s → ~42 s wall, summed file time 329 s → 246 s (3 runs each, shared host); counts unchanged (217 / 4722). `db.test.ts` and `capture-persistent.test.ts` opt out to keep the fresh-file path pinned. Mutation-checked: skipping the re-key fails 85 tests.

### Fixed

- **One incarnation fence on every ctl op** (`rr_fix_r3_fence`; `rr_r3_session_ignores_fence` P2, `rr_r3_send_unbound_incarnation` and `rr_r3_interrupt_unbound_incarnation` P3, one root cause). `expectIncarnation` was opt-in per op and only `send`/`fresh` carried it: `/new`, `/reload` and `/compact` ignored an explicit fence (an SDK caller naming the old pi could reset the replacement), and `send --interrupt` read the hello's incarnation but never put it on the request. `command` and `interrupt` now carry it and the extension refuses a mismatch before any session change, abort or dispatch. A caller that gives none is fenced to the incarnation its own hello named, on all four ops. New hello feature `fence`: an extension that lacks it ignores the field on `interrupt`/`command`, so the implicit fence is skipped there and an explicit one is refused (`AgentExtensionOutdatedError`, op `fence`) rather than silently dropped. `interruptAgent` takes `expectIncarnation`. Tests: `test/agent-transport.test.ts`, `test/agent-interrupt.test.ts`, `test/extension-mu-pi.test.ts`. Mutation-checked: dropping the default binding, the extension check on `interrupt` or on `command`, or the client's field on either turns the matching test red.
- **A pretty-printed JSON `mu log` line no longer wedges every peer's sync** (`rr_r1_multiline_json_segment`, P1). The segment writer passed valid JSON through byte for byte, raw LF included, so `mu log $'{\n  "x": 1\n}'` wrote one op as three physical lines. Each peer stopped at `torn-write` and never applied a later op from this machine. `appendLog` now stores JSON that spans several lines with its line breaks and the whitespace around them removed: in JSON these can only sit between tokens, so the value is unchanged. It does not re-serialise, which would round big numbers. Prose keeps its newlines (the segment escapes it). `encodeSegmentLine` now throws on a payload that would still span lines. Tests: `test/segments.test.ts` (pretty JSON with CR/LF: one line, a peer applies it with no defect and stores the same bytes, a second flush appends nothing; the encoder refuses LF and CR).
- **A log line can no longer be left out of the segment for good** (`rr_r1_log_clock_append_race`, P2). `appendLog` committed its HLC mint and its ops INSERT separately. If another process appended and flushed between the two, the later op was published first, and every later flush (`hlc > last published`) skipped the earlier one. The mint and the INSERT now run in one `BEGIN IMMEDIATE` transaction, so ops commit in hlc order. Test: `test/logs-append-atomic.test.ts` (two connections; the second appends inside the first's window and gets `SQLITE_BUSY`, so commit order equals hlc order).
- **`mu rebuild` reads its source in one snapshot and moves the clock past the newest copied op** (`rr_fix_r1_rebuild`; pre-release review R1, P2). The identity, ops, peers and loss counts were four separate reads. A clock-skewed peer op ingested between them was copied, but the older clock was carried, so the next local edit minted an HLC below it and a second rebuild restored the peer's value over the later edit. The reads now run in one transaction, and the rebuilt clock is raised to the newest copied HLC (never lowered), which also covers a stale carried clock from any cause. Tests: `test/rebuild.test.ts` (racing future-HLC ingest, stale source clock); mutation-checked (each fix alone fails its test).

- **`mu sql --write` edits that a rebuild or peer replayed wrong are refused or fixed** (`rr_fix_r1_sqlguards`, `CAPTURE_VERSION` 5; pre-release review R1, P2s). (1) A local `UPDATE` of a note's `author`, `content` or `created_at` (the old guard covered only `kind`) now raises: the log replayed it as a second note with a wrong author, and a rebuild diverged from live. (2) A note tombstone is `{}` only when the newest put under its key describes the deleted note (same author, content, created_at); otherwise it carries the full row. After a rebuild reassigns note ids, deleting a note whose id was reused killed the wrong note on the next rebuild and resurrected it. `mu db compact` applies the same rule. (3) A local `UPDATE` of an edge's `created_at` raises (set once): the fold reads only the first put. Ingest (`applying = 1`) is never refused. Tests: `test/sql-guards-replay.test.ts`, `test/compact.test.ts`; mutation-checked (each guard and the tombstone rule). Existing tests that edited notes through SQL now use `withCaptureSuppressed`.
- **A failed remote spawn whose rollback removed its worktree leaves no `remote_recovery` record** (`triage_dff_remote_recovery_pileup`, dogfood-full F2). Four `spawn --host dev --worktree --task` attempts that failed on `ctl refused` each left a record for one path, though each rollback had removed the tree. `agent close` then refused (`pass --recovery <id>`, then `newer recovery … owns`), and clearing them took 8 calls, 3 of them `worktree already gone`. `removeRemoteWorktree` now reports whether the tree is proven gone (an `MU_RM removed|gone|moved|dirty` line; not just exit 0), and `rollbackSpawn` deletes the row with `preserve: false` only then. A tree it left alone (HEAD moved, changes, unreachable host) keeps its record. Tests: `test/remote-spawn.test.ts` (the 4-attempt repro, and a left-alone tree keeps its record), `test/remote-spawn.integration.test.ts` (real git: removed means no record, a moved HEAD keeps one). Mutation-checked: always preserving turns the repro red; trusting exit 0 turns the left-alone test red.
- **One owner death is one `dead` event** (`dead_double_event`, p3_leftovers_post (b)). `claim --for` registers the task and its owner, so one death came back as two exit-6 waits: `dead` on the task, then `dead` on the agent. `select()` now folds the agent's `dead` into the task's (first and `--all`), as it already folds a settled run into the close its CLOSE block made: one event, the task as its ref, both refs `dead` in `refs[]`, both cursors written in the same delivery. Same death = the same registry row, or, after the reaper deleted the row, the owner the task names (a live tick, or the claim op's actor in the ops log, `reapFlip`). An unrelated agent's death, or a respawn under the dead owner's name (another row), stays its own event. Tests: `test/wait-delivery.test.ts` (pane gone, reaped, `--all`, two deaths); mutation-checked (drop either fold, the name fallback, or the row check).
- **A due course check now shows** (`f_course_hint_unwired`). `computeNotices` had no CLI caller, so the course-correct trigger never fired. `mu state` and `mu wait` now carry it as `data.notices: ["course check due: <n> closed since <date>. Stop dispatching: finish merging, then follow recipes/course-correct.md"]`, one line per workstream in scope (a wait's `-w`, else its refs' workstreams). The key is absent when nothing is due; the success envelope keeps exactly `{ok,data,next}`.
- **`task claim --for` no longer suggests a send tmux refuses** (`dogfood_harnesses`). For a non-pi owner (codex, cursor-agent, claude) on tmux, `next` was `mu agent send <w> 'Claim done: ...'`, which exits 4 (`AgentSendUnsupportedError`). The claim now offers no send there; herdr and pi owners keep theirs. The refusal itself names the tmux route that works: start the agent with the prompt as an argument (`--command "<cli> '<prompt>'"`).
- **`mu wait -w <ws> --wave <label>` sees the wave** (`triage_dff_wave_scope`, dogfood-full F1). The scope narrowed the wave to calls in `<ws>` or recorded on it, but `mu_delegate` defaults to `scratch`, so every wait from the orchestrator-loop recipe tallied `0/0 CONFIRMED` (or said `nothing to wait for`) while the answers sat done, and the orchestrator fell back to `sleep 40` loops. A wave is already the caller's, so `-w` no longer narrows it (it still narrows owned refs). A wave name none of the callers' calls carry is `no such wave: <name> (your waves: ...)` (`WaveNotFoundError`, exit 3) instead of `nothing to wait for`. Tests: `test/wait-surface-engine.test.ts`, `test/wait-cli.test.ts` (mutation-checked: restoring the scope filter turns 3 red; dropping the unknown-wave guard turns 2 red).
- **`next: mu wait` follows only a command that armed work** (`p3_leftovers_post`, docs_final_p3 (a)). The bare wait over owned refs followed every command (a `task show`, an unrelated update) while the caller owed anything. `computeNext` takes `armed`; the CLI sets it when the verb registered refs (`armWait`: `send`, `spawn --send`, `claim --for`). The dashboard (no verb) is unchanged. Tests: `test/next-hints.test.ts`, `test/next-finalise.test.ts` (mutation-checked: drop the guard).
- **A settled latch holds only the identity it captured** (`fix_latch_identity`, refuter rf-latch). (P1) In `mu task wait t1 --all --on-stall warn`, run 1 settled with a malformed CLOSE; w1 was then closed and respawned under the same name (a new registry row and a new pi), and the new incarnation's run 1 settled with a valid CLOSE, yet the wait timed out with t1 IN_PROGRESS. Only "more runs, same incarnation" superseded the latch. The rule is now one predicate (`supersededBy`, `src/wait-latch.ts`): a latch is valid only for its exact (agentId, incarnation, runs). An owner reading of another registry row or another pi process rearms it from that identity's own run 0, and a later run of the same identity rearms it from the latched run. (P2a) A wait read its cursors once, so a delegate another process consumed meanwhile was returned a second time. Delivery now re-reads the cursors in its immediate transaction, skips an event already consumed, and selects again. (P2b) Every fresh wait or resume logged `agent.stall` again for an unchanged stall. It is now logged once per task and (owner row, incarnation, runs), across waits and processes (a `stall-log|` mark in `wait_cursors`). Tests: `test/wait-latch-identity.test.ts`, `test/wait-cli-latch-later-run.test.ts` (respawn). Mutation-checked: dropping the agentId or the incarnation half of the predicate turns the matching P1 test red; dropping the in-transaction re-read turns P2a red; dropping the once check turns P2b red.
- **A later run always supersedes a settled latch** (`fix_latch_later_run`, refuter rf-steer). The wait engine held a settled run until it was delivered, and only a successful steer let it go. Two repros: (a) `mu wait -w w --all --on-stall exit` ended on run 1's malformed CLOSE (exit 7), and its printed `mu wait --resume …` saw run 2 settle with a valid CLOSE yet still exited 7 with the task IN_PROGRESS and the reason blaming run 1; (b) `mu task wait t1 --all --on-stall warn` with run 1 settled mid-task and run 2 closing ran to its timeout, task still open. The rule now: a latch holds one settled run until it is acted on, and an owner reading with more ctl runs (same pi process) drops it and rearms the watch from the latched run, so the later run is read, its CLOSE applied once (`agent_settles`), and a stall or refusal describes the newest run. The steer rearm from fix_allstall_steer_rearm is now one case of the rule. A stall carried past a `--on-stall release` keeps its owner and the refused CLOSE, and a plain stall's reason names the owner, how long it has waited, and the fix (`mu agent read`/`send`, or `mu task release`). Tests: `test/wait-surface-engine.test.ts`, `test/wait-cli-latch-later-run.test.ts`; mutation-checked (dropping the supersede turns both repros red; the steer tests stay green).
- `mu task wait --all --on-stall steer`: after the steer the wait now reads the owner's NEXT run (and its CLOSE block) instead of ignoring it and returning `stall: budget-exhausted` (exit 7) with the task still IN_PROGRESS; the stall reason also keeps the `--on-stall` action when a CLOSE was refused (fix_allstall_steer_rearm).
- Skill: the description now carries the rule that mu's DB is read with `mu sql "<SELECT>"` and never written (every write is a verb); the release matrix showed `next` haiku writing raw `sqlite3` INSERTs in 6 of 9 reps because it never read the SKILL.md body. remote-workers: `--after-runs <n>` names its value (the spawn's printed `runs`, 0 fresh). Gate re-run in `docs/mu-next/eval/matrix-release.md`: 0 of 9 raw writes, `remote_spawn` 3/3.
- **An open human stop no longer silences the settle** (`settle_human_stop_silences`, dogfood-switch d8). After one `mu human-needed` (for one item) every settle skipped its wait for the rest of the session, while delegate wakes said "the settle shows them". Under an open stop the settle still does not block or continue the turn, but it drains what is already ready (`mu wait --first --on-stall exit --timeout 1`, repeated) and shows each event with its delegate report, so the wake's promise holds. Test: `test/extension-nudge.test.ts` (the d8 shape, mutation-checked).
- **Help and guide wording from dogfood-3/4/switch** (`docs_final_p3`): `task close --why` says `done` takes `--evidence`; `task notes` says a newline prints as `\n`; `wait` help names `cursorCut` and that `resume` takes no other flags; a delegate answer without a `VERDICT:` line closes `answered with no VERDICT line`; the guides explain a worker's `close.applied:false`, Esc versus a later delegate answer, `--attempt` after a dead worker, and one Move pointer; the Move recipe says what to write when the last note is the brief.

- **A delegate in a named workstream no longer closes its own task and loses its answer**
  (`triage_dfs_delegate_self_close`, dogfood-switch F1). The close nudge told every delegate
  (spawned `--task <its call task>`) to run `mu task close`; `finishDelegate` then found the task
  CLOSED and wrote no report or verdict (15/15 calls: tally "0/2 CONFIRMED", "Report unreadable"). Two
  fixes: the close nudge skips a `kind=delegate` task, and `finishDelegate` keeps the answer as the
  report (and the real verdict on the judged task) when the task was closed by the delegate itself,
  told from a closer that is not the delegate by the author of the task's close note (the call row's
  `agent`). A task the orchestrator or a user closed is unchanged. Red tests:
  `test/extension-close-nudge.test.ts`, `test/delegate-tasks.test.ts`.

- **`/reload` no longer orphans a running pane delegate** (`triage_df4_reload_orphan`, dogfood-4 F2). The
  old runtime's watcher died with the reload while the call stayed `running`, so nothing recorded the
  answer and the settle wait owed it for ever (open:1 after 4 min 44 s). On `session_start` the
  extension now re-adopts this pi session's `running` pane calls (`mu delegates list --caller
  pi:<session>`): it watches each again (`mu agent wait --after-runs 0`, a one-shot delegate's first
  run) and delivers through the usual recorder and wake. A delegate that finished meanwhile is
  recorded at once; a pane that is gone fails the call. The shutdown warning says so on reload.
  `docs/guide/delegate.md` now states this. Red test: `test/extension-delegate-durable.test.ts`.

- **A wave whose answers are already recorded is shown once, not once per delegate** (`triage_df4_wave_once`,
  dogfood-4 F1). The settle's wave loop only ran while a sibling was pending, so with none pending it
  showed the firing call's summary and the next settle repeated it for the next call (3 entries, then one
  per closed task). It now keeps running the owned wait until every non-refused call of the wave has been
  handed over, then shows ONE summary with every answer. Red test: `test/extension-delegate.test.ts`
  ("a wave already recorded before the settle is ONE entry").

- **A malformed `CLOSE` block ends a task wait instead of hanging it** (`close_block_malformed_visible`).
  Reproduced on the built CLI with the old driver (empty `REPORT:`): `mu task wait f1 f2 f3 --all
  --status CLOSED` ran to its whole timeout with `3 still open` and said nothing, though the tasks
  already carried `no close (malformed): the report is empty`. Under `--all` the owner's settled run is
  no target and is never delivered early, so the engine's "a stall never beats an unprocessed settle"
  guard held the stall back for good. The guard now applies to `--first` only (there the settle goes
  first and carries the refusal); under `--all` the run's CLOSE is already applied, so a task it left
  open is a stall (exit 7) at once. The stalled task's snapshot carries `close` (the refusal) and the
  reason names the owner, the refusal and the fix (`mu task close ...` or resend the block). Kernel-adjacent:
  mutation check, reverting the guard fails `test/wait-surface-engine.test.ts` (`--all`).

- **`--first` with `--all` names the way out** (`matrix_fanout_close_block`). The `UsageError` now says
  to drop `--first` to wait for every ref or drop `--all` to return on the first. The matrix loss it
  came from (`fanout_gates` on next, reviewer waits never settling) was a harness defect, not a wait
  defect: the scripted worker's `CLOSE:` block carried an empty `REPORT:` when its task script printed
  nothing, so `applySettledClose` recorded `no close (malformed): the report is empty` and
  `mu task wait r1 r2 r3 --all --status CLOSED` correctly stayed open. `tools/eval/fixtures.ts` now
  reports `<task>.sh exit 0`; a test parses the driver's block. `fanout_gates.golden-task-wait.next.json`
  proves the closes land through `mu task wait` alone.

### Added

- **`mu delegates run <call-id>`: the mux-free delegate runner, part 1** (`v_nomux_runner`, split of
  `v_delegate_nomux`; the `mu_delegate` hookup is part 2). One child `pi --mode rpc` (detached
  process group, retained stdin, log and session under `<state dir>/delegate-process/<hash of call
  id>/`), the shipped mu extension loaded explicitly, a call-id-derived ctl socket and agent name.
  No pane, no agents row, no daemon: `delegate_calls` and the task stay the authority, and the
  verdict, report and close go through `finishDelegate` before the child's stdin is closed.
  The prompt is sent once with a stable msgId and the handshake's incarnation; a reply lost after
  the write is confirmed by `status {msgId}`, and an unconfirmable delivery or a leftover attempt
  receipt finishes `unknown` (evidence kept, never respawned or resent). A failure before the send
  refuses the call (reissuable). `workspace` reuses `src/worktree.ts` (dirty or unmerged work is
  kept), `keep` holds the live child, SIGINT cancels. Result: `transport: "process"`,
  `attach: null`, log and session paths. Code: `src/delegate-process.ts`, `src/cli/delegates.ts`.
- **`mu_delegate` works with no tmux or herdr, part 2 (`v_delegate_nomux`).** The tool registers
  in any unmanaged pi (`MU_MANAGED_AGENT` and `MU_DELEGATE=0` still hide it). When the spawn fails
  `NoMultiplexerError` (that error only; any other spawn failure is refused as before) the call runs
  through `mu delegates run <call-id> --no-keep`: same admission, queue, refusal and reissue; the
  runner records the verdict, report and close; the follow-up names the session and, on failure,
  the log; it has no pane and no attach line (`details.transport: "process"`, `attach: null`).
  `keep` needs a pane and is dropped (the result says so). `mu_delegate_cancel` SIGTERMs the run
  (20 s before SIGKILL, so the runner can stop its child), which cancels the call durably; a run
  killed before its handler, or one that dies without a result, is finished by the extension
  (`cancelled` / `failed`), never left `starting`. `/reload`, `/new` and resume leave a run going
  (its answer lands on its task); quit cancels it. `delegates run --no-keep` overrides a call's `keep`, and
  its result carries `answer`. Eval: `no_mux_delegate` (tmux and herdr absent from the caller, its
  mu and the delegate; next family). The faux worker driver also treats `delegate_<id>` (a mux-free
  delegate's name) as a delegate.

- **`mu next --refute`: an opt-in durable checker per closed attempt** (`v_exec_refute`, slice C of
  `v_executor`; `src/next-refute.ts`). For each authorised task a worker closed as `done`, one
  delegate call (`refute:<ws>:<task>:<attempt key>`, workstream `scratch`, wave `refute-<ws>`) is
  registered `starting` BEFORE any pane, then launched through the journaled `spawnForTask` (the
  checker's pinned brief + the worker's report, note numbers named) and marked `running`. A later
  `mu next --refute` reads its settled run once (bounded) and `finishDelegate` records: the verdict
  note lands on the judged task, then the call's report and close. A dead checker, a hung one (30 min)
  or one that could not start is recorded `failed` (UNVERIFIED), never retried; a first send that may
  have landed is probed once and never resent. Never accepts, reopens or closes the judged work and
  never grants auto permission; a wontfix/rejected close gets no checker; only this caller's calls are
  touched. Needs a caller identity (exit 2 without) and a ctl cli (`--refute-cli`, default the task's
  own). `--hold` also waits on running checkers. Every launch, read and record counts against `--cap`;
  `--dry` lists the owed checks. `pinnedNotes` is the shared brief/report lookup of `buildTaskBrief`.

- **`computeNext`: one read-only rule set for `next`** (`v_hint_rules`, slice A of `v_hints`; SDK
  only, results still print `next: null` until `v_hint_wire`). `src/next-hints.ts` computes a
  `NextPlan` from current state plus what the verb did: the exact `mu wait 'agent:<ws>/<n>@<runs>#<inc>'`
  a delivered send owes (the send's own baseline), `mu agent check <a> <msgId>` for an unknown delivery
  (only while the registry row it went to stands: the check has no `--inc`; never a resend), a gate's
  wait, the `--fresh` brief a `claim --for` owes, a preview's apply with `--if <rev>`, the stored
  `mu wait --resume <id>`; then `mu next -w <ws>` when work is authorised here and the bare `mu wait`
  over owned refs, both withheld while a caller has an open human need. Reads are never suggested; a
  refused delegate call (reissued by the pi tool) never is. Every command is rendered from argv with
  POSIX quoting (a test runs each through `sh`); an unguarded destructive move throws; `capPlan` drops
  an oversized `seq` whole. `agentRefOf`, the claim prompt and `resumeCommand` now come from this one
  builder. Exported: `computeNext`, `renderArgv`, `renderPlan`, `capPlan`, `NextPlan`.
- **Course check due** (`v_course_hint`; SDK, rule only). `courseCheckHint(db, ws)` in
  `src/next-hints.ts` returns `course check due: <n> closed since <date> (recipes/course-correct.md)`
  once a workstream has 10 CLOSED/done work tasks (counted by close-note time), or 24 h with at least
  one, since its newest `COURSE CHECK` note, or since it was created if there is none. A newer note
  clears it. The thresholds are constants (`COURSE_CHECK_CLOSED`, `COURSE_CHECK_AGE_MS`), not flags or
  env. `computeNotices(db, ctx)` returns it as the one-line notices beside `next`; printing them in
  `mu state` / `mu wait` is the output finalisation (`v_hint_wire`). Read-only, one query, no schema change.
- **Switch note** (`v_cutover_runbook`, docs only). `docs/guide/upgrade.md` "Switch to mu-next" covers
  the per-machine switch with no flag day: install beside 3.x, move workstreams with the Move recipe,
  keep 3.x as a read-only archive, and roll back by going back to 3.x (`task unpark` for a moved
  workstream). It also gives the one-line new-model bench (`tools/eval/main.ts matrix ... --out
  docs/mu-next/eval/models.jsonl`) and points to `v_eval_next` for the release gate.
- **Dogfood 2** (`dogfood_after_v_wait_cli`): `docs/mu-next/eval/dogfood-2.md`, an isolated loop on
  `mu wait`.

- **Remote command gates** (`v_remote_gates`, core; SDK only). `spawnAgent` with `host` and an
  explicit `--command` that is not pi (argv0 not `pi`/`pi-meta`, `cli` not explicitly `pi`) is a
  *gate*: a foreground remote command whose exact numeric exit `mu wait agent:<ws>/<name>` returns
  as `data.exit` and the process exit (`23` stays `23`; `exited` is a new wait event, the
  snapshot carries `exit`). Decided before any effect and stored as `agents.gate_token` (nullable,
  machine-local, same schema version; an existing file gains it on open; it joins `agentRevision`
  and the agent JSON as `gate_token`). A gate speaks no ctl (`expectsCtl` is false whatever `cli`
  says), is not startup-scanned, is never auto-closed, and refuses `--worktree` before any effect.
  tmux arms `remain-on-exit` on its own pane BEFORE the command runs (new optional
  `SpawnAgentPaneOptions.retainOnExit`: a placeholder pane, `set-option -p`, then `respawn-pane`)
  and reads it with the new optional `MuxBackend.paneResult` (`running | exited{code,signal} |
  absent`; a failed probe throws = unknown); herdr keeps refusing `--host`. The LOCAL pane's
  status is not the answer (a shell template may swallow it): the remote wrapper writes
  `MU_GATE <token> <rc>` atomically under `~/.local/state/mu-next/remote-gates/`, read with the
  profile's `exec` only after the pane is proven exited, and its channel freed by registry id +
  pane (so at `--max-sessions 1` the read admits, and so does the next spawn: `localPaneAlive`
  treats a retained dead pane as transport-dead). A missing, malformed, over-255 or foreign
  record, a signal or a lost transport reads `dead` (exit 6), never success; an unreadable probe
  or exec reads `unknown` and keeps the lease. Repeated waits reproduce the result; an owned
  cursor consumes it once; `agent close` removes only its own token's record. `WaitResult.exit` is
  widened from `0|6|7|130` to a number; under `--all` it is the first nonzero gate code. The
  legacy `waitForAgents` adapter reads a nonzero gate as `dead`. The CLI (`f_gates_cli_flags`): `--cli`
  has no commander default, so `spawn --host H --command 'npm test'` is a gate verbatim; `--task`,
  `--send`, `--attempt` and `--worktree` with a gate are refused before any effect (usage, exit 2);
  the Next: hint is `mu wait agent:<ws>/<name>`, which exits with the command's code.

- **`--on-stall steer|release`** on `mu wait` and `mu task wait` (`f_steer_cli_wiring`). `runWait` now
  calls `waitWithActions` with the merged `steerStallHandler` / `releaseStallHandler`. The stall
  result names what was done (`sent`, `released`, `refused`, `unknown`, `budget-exhausted`): one
  stderr line per handled stall, `data.action`, and the `reason` text. `steer` continues the wait;
  `release` and every non-sent outcome end it with exit 7. Both act only on workers the caller
  spawned and on tasks permitted with `mu task auto`. `--resume` replays the action. The usage
  error for an unknown value names all four.
- **Producer arming and the one wait hint** (`v_wait_arming`, slice B of `v_wait_cli`). A producer
  that did something registers what it owes the next `mu wait` (`wait_registrations`), so a bare
  `mu wait` or the settle hook owns it without parsing a shell line. Armed: `agent spawn --send`
  (plain and `--next-free`, for the ACTUAL returned agent, once the prompt is delivered),
  `spawn --task` (the task and the agent, from the saved receipt; a replay re-registers the same
  refs; a stale identity arms nothing), `agent send` and `send --interrupt` (a delivered prompt),
  and `task claim --for` (the task in its OWN workstream plus the owner agent read from
  `owner_id`, so cross-workstream works). Not armed: `claim --self` and a worker's own claim
  (the caller would wait on its own work), a slash command, an undelivered or failed or UNKNOWN
  send, a plain shell with no identity. The caller is the managed `<ws>/<agent>`, else
  `pi:<session>`. An agent ref carries the UNCONSUMED fence the producer measured BEFORE its
  effect (ctl runs, pi incarnation, registry id; the earliest run of one process wins on a repeat
  send; a replacement agent gets its own), so a run that settles before any wait starts is still
  delivered. A registration that cannot be stored (the 256-ref cap, a vanished entity) never
  rolls the committed effect back: it is `warnings` in the producer's document. Direct SDK calls
  (`spawnAgent`, `sendToAgent`, `claimTask`, `spawnForTask`) do not arm: the verbs do, and the
  engine's provenance discovery covers the rest.
- `mu agent send --wait` and `mu task claim --for <w> --and-wait` enter the wait after the
  producer: one JSON document, the wait's (`firing`, `exit`, `snapshots`, `resume`; SIGINT/SIGTERM
  print a snapshot), with the producer's receipt as `data.sent` / `data.claimed`. Errors are JSON
  too. `--and-wait` needs `--for`; `--wait` refuses a slash command; an undelivered send waits for
  nothing.

- **Guarded stall release and action receipts** (`v_wait_release`, slice C1 of the wait core; SDK
  only, no CLI flags yet). New machine-local table `wait_action_receipts` (25 tables; additive,
  same schema version, an existing file gains it on open; never captured or synced; no foreign
  keys; a rebuild reports its rows as lost). One row per task id + owner registry id + ctl
  incarnation + action, shared by every caller, restart and generation. `releaseStall(db, ctx)`
  / `releaseStallHandler` implement `handleStall` for `onStall: 'release'`: in one immediate
  transaction it rechecks the callers set, wait generation, task PK/kind/status/revision, owner
  id, name and pane, that a caller spawned the owner, `autoPermitted` and `openHumanNeeds` of
  every caller, then calls `releaseTask(expectedOwnerId, ifRevision)` (no reopen) and writes the
  receipt. A failed guard writes nothing and returns the stall; a second release for the same
  incarnation is `budget-exhausted`. The engine keeps reporting a handled `return` stall even
  though the release removed its condition.

- **Crash-safe stall steer** (`v_wait_steer`, slice C2 of the wait core). `steerStall(db, ctx)` /
  `steerStallHandler` implement `handleStall` for `onStall: 'steer'`; `waitWithActions(db, refs,
  opts)` is `waitForEvents` plus the handler `onStall` names (steer or release). One fixed plain-text
  reminder per task + owner + ctl incarnation, shared by callers, restarts and generations: the
  receipt is reserved with its msgId, then a synchronous final fence (`beforeWrite`, on connect,
  right before the write) re-runs every guard and compare-and-sets `reserved -> sending`; only the
  winner writes. The extension remembers msgIds but does not dedupe sends, so SQLite, not the msgId,
  is the exclusion. A crash at `sending` is `unknown`: probed (same registry id, pane and
  incarnation), never resent, never turned into a release. An accepted nudge continues the same
  wait from the receipt's run baseline; refused, unknown, aborted or exhausted returns the stall
  with the action. `ctlRequest` gains an opt-in `beforeWrite` fence (`CtlWriteVetoedError`) and an
  abort after a side-effecting write is now `CtlDeliveryUnknownError`; `sendViaTransport` gains
  `ctlGuard` (signal, timeout, fence). Defaults unchanged. Receipts allow `sending -> refused`.
  A probe-confirmed earlier steer whose run already settled (receipt runs below the owner's) returns
  the stall ("nudged earlier, owner idle again") instead of a silent continue; a fence on a
  session-command text (`/new`, …) is refused, not skipped.

- **Delegates are durable tasks: `mu delegates`, `mu_delegate_reissue`, wave tally** (`v_delegate`, part A: the mux path;
  delegates with no tmux or herdr are `v_delegate_nomux`). Every `mu_delegate` call is a `kind=delegate` task
  (in `scratch` or the new `workstream` option) with the prompt as its brief and a session-qualified `call_id`
  (`pi:<session>:<n>`), created with its `delegate_calls` row in one transaction (SDK `registerDelegateCall`; the same id
  with the same request is a no-op, a changed request is refused, exit 4; the `record` target must exist or nothing is
  written). The tool result is `{ task, state, call_id }`; new optional `wave` groups a fan-out. States: `queued starting
  running recording done failed refused cancelled`. A queued or refused task is parked, so it never reaches `mu task
  next` or an executor. The delegate is spawned through the task-bound `agent spawn --task <task> --attempt <task>`
  (the journaled path: a replay never sends twice, and a replay or stale receipt, which carries no top-level `ctl`, is
  handled). The one recorder, `finishDelegate` / `mu delegates finish`, commits `recording`, then writes in ONE op group
  the verdict note on the judged task, the delegate's report and its close; the delegate task is closed before the
  pane. A failed record leaves the call `failed` (task closed `rejected`, the answer kept as its report, the pane kept),
  never `done`; a repeated callback writes nothing twice. **Refused, not thrown:** past `MU_DELEGATE_MAX` plus four
  caps' worth of queue a call is recorded as `refused` with its brief and record target, outside murmur's
  `murmur:pending` count (payload unchanged); `mu_delegate_reissue { call_id }` moves it
  back once, same call, same task (`mu delegates reissue` refuses and names the tool: only the live runtime that holds
  the queue can start or drain a call, so a shell reissue would strand it as `queued`; `mu delegates mark <id> queued`
  is that runtime's step). A `/reload` or quit parks queued calls as `refused` instead of dropping them.
  **Full evidence:** the verdict is the FIRST line that is `VERDICT:` or `<WORD>: VERDICT:` (nothing else before it; later `VERDICT:` lines are
  evidence text, kept verbatim), the verdict note keeps everything from it on, and a
  note without one keeps the whole answer; the 4000 and 1500 character caps are gone, and the same answer is the
  delegate task's report. New verbs: `mu delegates list [--caller|--all|--wave|-w]`, `show`, `tally -w <ws> --wave
  <label>` (CONFIRMED/REFUTED/UNVERIFIED per judged task, one result per call, queued/running/refused counts),
  `register`, `mark`, `finish`, `reissue` (refuses). SDK: `registerDelegateCall`, `markDelegate`, `finishDelegate`,
  `listDelegates`, `getDelegateCall`, `verdictTally`, `parseVerdict` (package entry).
  `addTask` takes `kind` and `wave`. `delegate_calls` gains `request`, `verdict` and `agent` (nullable; v13 is
  unreleased, so no version bump). Unchanged: `MU_DELEGATE=0`, the managed-agent no-recursion guard, `answerPending`,
  the arriving/stub/single-resend/Escape machinery. `extension/delegate.ts` is split (`delegate-calls`,
  `delegate-format`, `delegate-args`, `delegate-trace`, `mu-run`).

- **Wait registrations and one typed agent observation (storage and seams for
  the unified wait; no new verb).** The machine-local `wait_registrations`
  table (`caller`, `refs_json`, `state` armed|waiting, `generation`,
  `updated_at`; no foreign keys, never synced, not rebuildable and reported as
  lost) records the typed refs (task, agent, delegate) a caller still owes a
  wait. `registerOwnedWait(db, caller, refs)` validates, merges and dedupes
  (at most 256 owed; one bad ref stores nothing). Every ref must exist when
  registered, checked inside the registering transaction: the task or agent in
  its workstream, the delegate call exactly as `delegate_calls.call_id` stores
  it (no id grammar of its own), the workstream; a missing one refuses the
  whole call with one line naming it. A ref whose entity is deleted later stays
  owed. `beginWait` bumps the
  generation and marks `waiting`; `endWait(db, caller, generation, delivered)`
  is a compare-and-set that removes only the delivered refs, so an older wait
  finishing late cannot overwrite a newer one and an undelivered sibling stays
  owed. Each write is one short transaction, never held across an await, and
  nothing here touches `wait_cursors`. `AgentObservation` (`observeAgentStates`,
  `watchAgentRun`, `settledCloseInput`, `toStatusSnapshot`) carries the registry
  id and pane, pi's incarnation, the settled run count, `settled`, the final
  text with `lastTextTruncated`, `pending`, source/since and the session file;
  `mu agent wait` now builds its watch and reads on it, output unchanged.
  `readAgentStates` also returns ctl's `incarnation`. Producers do not arm yet
  (that is `v_wait_cli`). No schema bump: an existing v13 file gains the table
  on open (same-version additive repair).

- **Close or collect the remote worktree a removed agent left (`v_remote_recovery_close`).**
  `mu agent close <name>` with no agent row and no local orphan now selects the ONE
  `remote_recovery` record of `<ws>/<name>` and closes THAT worktree under the unchanged remote
  rule (`closeRemoteWorktree`: quiescence, common-git-dir check, clean + base/collected HEAD or
  create-only `--keep-branch`, no `--force`, dirty refuses under every flag), through the
  ORIGINAL incarnation's aside, so a close that crashed after the move and was then reaped
  resumes from the aside it left. No agent returns and no pane or task is touched. Several records
  of one name refuse (`RemoteRecoveryRefusedError`, exit 4) and list their ids; `--recovery <id>`
  (SDK `recoveryId`) picks one. The preview reads only (no remote command), reports
  `kind: "recovery"` with `recovery_id` (`id` stays the registry incarnation, null here) and a
  `rev` derived from the record (`agentRevision(db, ws, name, recoveryId?)`), plus the refusal an
  apply would hit now. An explicit `--recovery <id>` that is gone never falls through to a live
  agent: close is a no-op, the preview is `kind: "none"` (rev 0, no apply hint), collect refuses. Apply holds the agent lock, checks the revision, and compare-and-sets
  the record and the registry before the removal; the record is deleted only when the tree is
  removed, kept on a branch or gone, and only that record. A current agent of the name or on the same
  host and path, a NEWER record of the same host and path (a reused name lands on the same
  deterministic path: only the newest record acts, the older refuses naming it), a missing or replaced host profile, and a record written without a profile
  identity refuse before any exec. `mu agent collect <name>` (also `--recovery`) works on a
  record the same way (same fetch, repo lock and exact-SHA pin; the record's `collected_head` is
  compare-and-set) and refuses to move the one `refs/mu/collect/<ws>/<name>` pin while another
  record of that name relies on the commit it holds. A removed agent's `-w <ws>` or `<ws>/<name>`
  works after a reinit or when the workstream has no live agent. `cmdClose` moved to
  `src/cli/agent-close.ts`. SDK: `selectRemoteRecovery`, `recoveriesFor`, `getRemoteRecovery`,
  `RemoteRecoveryRefusedError`, `CloseAgentOptions.recoveryId`, `ClosePreview.recovery`.

- **One owned-event wait engine** (`v_wait_engine`, slice B of `v_wait_core`).
  `waitForEvents(db, refs, opts)` (`src/wait.ts`, also exported from the package)
  is the only wait loop; `waitForTasks` and `waitForAgents` are adapters over it
  (`callers: []`, `eventScope: "refs"`) and keep their outputs; the
  `mu task wait` / `mu agent wait` / extension consumers are unchanged until
  `mu wait` (`v_wait_cli`). One iteration reads the DB, makes ONE batched agent
  read, applies settled CLOSE blocks and picks; then it races an agent ctl
  watch settling, the poll sleep, abort and the deadline. A blocking watch is
  never awaited serially and every read is raced with abort and deadline, so
  twelve delegate reports surface one per wait while four workers stay busy.
  `WaitOptions`: `callers` (a SET: the managed `<ws>/<agent>` that owns spawned
  workers and human stops, and `pi:<session>` that owns delegate calls;
  `currentCallers()` reads them from the env; owned refs, delegates, human
  needs and the wave tally are the union, `[]` owns nothing and a wave with no
  callers is refused, never an all-caller fallback), `mode` `first|all`,
  `eventScope` `owned|refs` (`refs`: only the listed refs end the wait and
  nothing owned is seen or consumed; the delegate recorder uses it), `wave`,
  `blockersOf`, `status`, `until` (`idle` or a bounded `{text}` regex),
  `timeoutMs` (default and cap 1500 s, 0 means the cap), `stuckAfterMs`,
  `onStall` `exit|steer|release` with `handleStall`, `signal`, `pollMs`,
  `beforePoll`. `WaitResult`: `event` (`closed settled input dead stall delegate
  heartbeat interrupted`), `refs` snapshots (they keep the observation facts:
  `agentId`, `paneId`, `incarnation`, `settled`, `runs`, `lastText` +
  `lastTextTruncated`, `lastError`, `sessionFile`), `timedOut`, `interrupted`,
  embedded `exit` (0, 6, 7, 130), `cursor`, `humanNeeds`, `tally`, `action`.
  **Stalls**: the engine detects them (an IN_PROGRESS `kind=work` task whose
  owner sits needs_input, or behind a dead control socket, for `stuckAfterMs`;
  default 120 s, 5 s over a working ctl socket) and returns a `stall` event
  (exit 7). With `onStall: steer|release` and a `handleStall` it hands the
  stall over once per `stallToken`: the hook is raced with the loop, so a slow
  steer never starves an owned delegate report or a death; `continue` keeps
  waiting without consuming the ref, `return` ends the wait with the action on
  the result; a throwing hook is an honest `unknown`. The policy and effects
  (release, steer, receipts, budget) are `v_wait_actions`'; the engine has none.
  **first** returns the best event (dead, input, stall, delegate, then
  closed/settled; listed refs before owned); **all** returns when every target
  is done, and an urgent owned event ends it early without counting toward
  "all". Only DELIVERED refs are consumed: their typed cursor tokens
  (`wait_cursors`: an agent's ctl incarnation + settled run, a closed task's
  newest note id, a delegate's terminal state) and their removal from the
  registration are one transaction guarded by each owning caller's generation,
  so a sibling `first` did not return stays owed, history is not replayed, a
  stale high run count never hides a new pi process, and an older wait
  finishing late consumes nothing (`superseded`). **Producer fence**:
  `wait_registrations.baselines_json` (additive column, same-version repair)
  stores per agent ref the UNCONSUMED baseline a producer registered
  (`registerOwnedWait(..., {..., baseline: {afterRuns, incarnation, agentId}})`),
  distinct from consumed cursors: the ctl watch counts an owed ref from
  `max(baseline, same-incarnation cursor)` when the baseline's registry id and
  incarnation still match, so a send that settles before any wait starts is
  caught; a baseline of another process or a replaced registry row is ignored;
  it is dropped when its ref is delivered. **Round 2 (durable, exactly-once,
  fair)**: no per-wait memory decides what was seen. An event is consumed only
  when it is the one returned; every kind has a cursor key (a `blockersOf`
  blocker seen open is recorded under `open|`, so a sibling close that a `first`
  did not return stays owed; an unchanged dialog, dead owner or stall is
  recorded under `input|`/`dead|`/`stall|` with a token naming its state, so it
  is news once per state change and never outranks a never-returned event, a
  delegate report included). The fence applies to every registered agent ref,
  explicit or owned, and an owed ref with no fence and no cursor counts from
  the run count probed now (stored as its fence, `unknownBaseline` on the
  snapshot): a historical run is never completion. A settled pi run's CLOSE block is
  applied once before the snapshot returns; `applySettledClose` refuses
  delegate tasks like human ones, so a delegate answer ending in a CLOSE block
  cannot close its task ahead of `finishDelegate`'s recorder. `verdictTally`
  takes `callers?: readonly string[]` as its 4th parameter (one form; `mu state` passes `[caller]`; and `listDelegatesOf` the union) so waves with one name
  stay apart. `--until-text` takes a bounded regex (`src/wait-regex.ts`): at
  most 200 characters, no backreferences or lookaround, no repeated group
  containing a repeat or an alternation, counts up to 1000, matched on the last
  8 KiB inside a 50 ms `node:vm` budget; a refused or runaway pattern is a typed
  error, never a hang. Not here: stall policy and effects (`v_wait_actions`),
  the `mu wait` CLI and signal wiring, and arming from spawn/send/claim
  (`v_wait_cli`).

- **A deleted remote worker row no longer takes its worktree's location with it.** A new
  machine-local table `remote_recovery` (no foreign key, no op, never synced) keeps, per
  ORIGINAL registry incarnation, the host, worktree path, base, last collected HEAD, the exact
  `.mu-removing-<id>` aside path and the profile's exec/repo of a finalized remote row, written
  by the DATABASE: an AFTER DELETE trigger on `agents` (and a BEFORE DELETE one on `workstreams`
  for the cascade), so every path that deletes the row is covered: the reaper (`deleteAgent`,
  so `reconcile` too), `workstream teardown`, reinit, a peer's workstream tombstone, and plain
  `mu sql "DELETE FROM agents"` / `"DELETE FROM workstreams"`. A failed identity check or a
  rollback records nothing and deletes nothing; local, cwd-only and base-less rows record
  nothing; an `agent close` that removed the tree itself records nothing. The DDL lives in
  `src/db-recovery.ts` (db.ts stays under its file cap). Teardown now
  deletes its dead rows through the same reaper step, which also fixes a task left
  `IN_PROGRESS` with no owner: it reopens with a `[reaper]` note, as after any reap. Storage
  only here; the readers follow below. Records are lost by
  `mu rebuild` (reported with the other machine-local tables): back up the source DB. SDK:
  `listRemoteRecoveries`.

- **`mu db query` / `mu sql` print JSON by default, paged like task lists.** A read's
  `data` is `{items, count, more}` (was a bare array): rows are kept whole while the final
  document fits 4 KB, `more` counts the rest and `retrieve` is the same query with the new
  `--all` (every row, whole). One row over the cap gives zero items and `retrieve`; cells are
  never cut. `--table` prints the old human table and prose. Parse-time, scope and DB-open
  errors are the JSON failure document too (for these two verbs only; every other verb still
  needs `--json`). Writes keep `{changes, lastInsertRowid}` / `{statements, multiStatement}`;
  `UPDATE ... RETURNING` prints its rows whole with no `retrieve`. Callers of the bare array
  (`.data[0]`) read `.data.items[0]`.

- **`mu next --workers <n>`: the worker ceiling is enforced, not prose (`df1_ceiling_not_enforced`).**
  No new pane while `n` workers are WORKING: an agent that owns an IN_PROGRESS task, or holds an
  executor attempt in flight (`pane`/`claimed`/`sending`/`unknown`) for a task that is not CLOSED.
  An idle worker whose task is CLOSED (its close applied, its pane not yet closed) is free, so a
  third worker may start the moment the second's task closes. Checked at the loop and again in the
  spawn guard (a slot taken by a peer after the check rolls the reservation back unsent, charge
  kept, resumable); a reserved attempt that has no pane waits for a slot, one that has its pane is
  replayed regardless, and an in-place API-error retry needs no pane so the ceiling never holds it.
  A refusal is free (an `attention` move, `stopped: "workers"`, nothing reserved or charged);
  `--hold` waits at the ceiling and dispatches when a task closes. No ceiling by default.
- **Executor slice B: `mu next`, dead versus live-error recovery, bounded `--hold`, signals
  (`v_exec_recover`).** `mu next [--dry] [--hold] [--cap N] [--timeout s] [--on-stall
  exit|warn|steer|release] [-w ws]` prints ONE JSON envelope (`data.moves`, `used`, `stopped`,
  `held`, `exit`; 4 KB on final bytes, moves cut from the end with `movesCut`). Exit 0 done or
  capped, 1 an unsent spawn failed, 6 a worker died with nothing more to do, 7 a stall, a dialog or
  this caller's human need, 130/143 a signal. Recovery splits on what the pane says. A worker whose
  PANE IS GONE (`status null`) is reaped through `deleteAgent`'s registry-id + pane compare-and-swap
  (no new reaper) and its task, reopened with the reaper's note, is allocated again as a new attempt
  whose brief says the previous one died; a task a human reopened (no reaper note) is never
  re-dispatched. A LIVE worker whose last settled run ended in an API error is never reaped or
  duplicated: it is retried IN PLACE (`reserveRetry`, auto-attempt.ts: one run charged, a new
  `auto:<n>` receipt starting at `claimed` on the saved identity) over the same journaled
  `spawnAutoAttempt` send, with a reserved msgId and `expectIncarnation` bound to the pi that
  errored; an unsent failure (`keepAgent`) fails the receipt and keeps the worker, its claim and its
  worktree; a send that may have landed is probed once and never resent. The error is read over a
  ctl `wait` past `runs-1` (a status read does not carry it), bounded by 3 s and the signal. A busy,
  dialog-blocked, pending, unreadable or merely idle worker is left to the wait. A remote worker's
  tree is never reaped, retried or collected from here; an error or death at the run ceiling is an
  `attention` move that says what to raise. `--hold` dispatches once, then waits
  (`waitWithActions`, `eventScope: refs`, bounded by `--timeout`, default and cap 1500 s) for the
  first event on the in-flight workers, each worker's agent ref bound to its delivered run count and
  pi incarnation; a death or an API-errored settle is recovered and the wait goes on, anything else
  (closed, a clean settle, a stall, a dialog, a heartbeat) is returned. `--dry` reads no pane or
  socket and writes nothing. SIGINT/SIGTERM are installed before the DB opens and stop between
  effects; the one result says `interrupted`. The cap counts reaps and retries. `buildTaskBrief`
  takes `retry: true | "error"`. `casReceipt` (receipts.ts) is the compare-and-set a send fence
  needs. Eval: tier 1 and tier 2 on `fanout_gates` and `api_outage_resume`
  (`docs/mu-next/eval/units/v_exec_recover.jsonl`).
- **Executor slice A: attempt reservation, `buildTaskBrief`, guarded replay, dry run and cap
  (`v_exec_dispatch`; SDK only, the `mu next` verb, recovery and `--hold` are slice B).**
  `executeNext(db, {workstream, caller, dry?, cap?})` resumes stored attempts, then spawns, claims
  and briefs `authorisedReady` tasks; it never calls `authorizeTasks`. An attempt is
  `auto:<n>` in `spawn_receipts` with its record (name, cli, worktree, pinned brief/report note
  numbers) in `task_auto.last_spawn`. `reserveAttempt` charges the run, writes the record and the
  `reserved` receipt in ONE immediate transaction that re-plans first (revision CAS), so two `mu next`
  mint one attempt. A run is charged once per new attempt, never for a replay, receipt check or
  UNKNOWN probe; an unsent failure keeps its charge and its failed key is never reset (the next
  attempt is a new key and a new charge), so real spawns never exceed `max_runs`. Stored attempts
  (even a final one, which `authorisedReady` no longer lists) are resumed under their own key
  before anything new is allocated. `spawnAutoAttempt` (task-spawn.ts) is the guarded replay:
  permission is re-read before the pane and inside the pre-send transaction (a revoke is an unsent
  rollback). `buildTaskBrief` is the first `brief` note verbatim + the latest `report` note + one
  task/CLOSE footer, pinned by note number so a replay rebuilds the same text; no brief, no
  attempt. `cap` is an integer 1..100 (default 5) counting every effect (replays, spawns,
  failures); `dry` is the same selection over the read-only planner (no ingest, lock, mux call,
  receipt probe or write; tested on a readonly DB handle). This caller's open human need stops
  dispatch. New errors: `SpawnAttemptFailedError`, `SpawnAttemptGuardError` (exit 4),
  `TaskBriefMissingError` (4), `NextArgError` (2).
  Round 2: `last_spawn` stores the EXACT prompt and a replay sends those bytes (no rebuild, no
  pins, no drift). Every stored attempt reaches a terminal state on the first `mu next` that
  sees it unreconcilable (task closed, agent gone, receipt that disagrees with its stored
  request, UNKNOWN the one probe cannot confirm): `abandoned` (nothing was sent) or `needs_human`
  (the prompt may have landed: never resent; a one-line human need is recorded for the caller).
  An ended attempt is never replayed and never counted again. The cap counts every external
  effect, including a spawn the send guard rolled back (`rolled_back`). This caller's human
  need is checked right before each spawn and send, not only at the top of the loop.
- **`mu task auto <ids…> | --blockers-of <u> --cli <key> [--worktree] [--max N] | --off`:
  explicit, host-fenced permission for `mu next`.** Ready is never permission.
  `auto` stores the cli key, worktree mode and run ceiling in the machine-local
  `task_auto` row and, in the same transaction, writes the synced
  `dispatch_host` = this machine; the whole batch is checked first, so a
  refusal (another host's designation, a human/delegate task, parked, triage,
  CLOSED, the `scratch` queue) writes nothing (exit 4). `--blockers-of u` adds
  every open transitive blocker of `u` (uncapped, same workstream, not `u`).
  `--off` revokes this machine's permission and clears `dispatch_host` only if
  this machine holds it; it keeps `runs` and the spawn-replay receipt, and
  re-authorising never resets them. SDK: `authorizeTasks`, `autoPermitted`
  (enabled + `kind=work` + `dispatch_host` is this machine; ignores status, for
  steer/release) and `authorisedReady` (ready + permitted + `runs < max_runs`).

- **`mu human-needed <reason>`: a durable, caller-scoped stop for a human decision.**
  It records a `human` task (OPEN/parked, brief = the reason) and a new
  machine-local `human_needs(task_id, caller)` row in one transaction, the
  caller being the managed `<ws>/<agent>` or `pi:<session>` (no identity: exit 2;
  no shared `$USER` fallback). The same caller and reason is a no-op; a new
  reason appends a brief. `openHumanNeeds(db, caller)` lists only that caller's
  open needs. No error or queue refusal records one. A `human` task resolves only
  by an explicit `mu task close`: `task unpark`, `task claim` (even `--force`) and
  a settled CLOSE block are refused (exit 4, one line naming `task close`);
  every path back to OPEN (`task open`, `release --reopen`, the reaper) lands it
  in parked, never todo; `task show` no longer hints `unpark` for it.
  `human_needs` is machine-local and joins `UNREBUILDABLE_TABLES`: `mu rebuild`
  keeps the task and brief but cannot restore who recorded it, and reports the
  loss. No schema or capture version bump (an additive table; same-version
  repair creates it).

- **`mu host add | list | show | rm | init --ssh | check`: ssh-free host profiles.**
  A profile is your `--shell` / `--exec` / `--fetch` templates, a `--repo` and
  an optional `--max-sessions`, stored machine-local in the existing
  `host_profiles`. mu fills `{env}`, `{cmd}`, `{local_sock}`, `{remote_sock}`
  and `{cwd}` in one pass (each value one shell-quoted word, exactly the text
  you passed even inside your own quotes; `{cmd:sh}` etc. add a second-shell
  layer for ssh-style remote command text; `{env}` only the five whitelisted
  identity variables, every value shell-quoted, never the local DB, state or
  sync dir; `{{` `}}` literal braces; anything
  else refused) and runs the result with `/bin/sh -c` as its own process group, reaped on
  timeout or caller exit before its channel is freed. The group id is recorded on
  its `host_channels` row before the command starts, and the slot stays held while
  that group lives, even after the caller died by SIGKILL (the next admission no
  longer reclaims it under a live transport); the exit hook stays installed until
  the reap finishes, not just until the shell closes. It knows no ssh flags:
  `host init <n> --ssh` only prints a starter, and `host check` runs only the
  stored `--exec` (host answers, repo, `pi --version`, `pi list` names mu;
  `--agent <n>` also probes that agent's forwarded socket). A failing step is
  reported, never retried (exit 5). `host_channels` (new, machine-local) counts
  every channel against `--max-sessions`: reserved under `BEGIN IMMEDIATE`
  (the profile's cap is read in that transaction) before the connection opens, released by token, and a refusal names the
  holder (exit 4). A transient channel is reclaimed only when its pid is
  proven gone; an attached one rides the agent's registry id and pane and is
  reclaimed only when the pane is proven dead. `rebuild` reports its rows as
  not rebuilt. `spawn --host` reserves and binds them (below).

- **`mu agent spawn --host <profile> [--worktree] [--cwd <remote dir>] [--task t --send ...]`: remote spawn, the pane is the transport.**
  The local pane runs the profile's `--shell` template (`exec env -u <local MU_* vars> /bin/sh -c`), filled with the remote
  identity, your `--command` (default `pi`), the derived local socket, the
  remote socket (`/tmp/mu-<uid>/<ws>/<name>.sock`) and the remote cwd; the
  template starts the remote pi and forwards its ctl socket to the local path,
  so every ctl verb, receipt and handshake works unchanged and **the pane
  dying is the agent dying** (close, reconcile, teardown need no remote case).
  `--worktree` makes a detached `git worktree add` of HEAD (or `--from`) in the
  profile's `--repo` through its `--exec` (one short command, reaped before the
  shell opens, so cap 1 works), at `~/.local/state/mu/remote-worktrees/<ws>/<name>`
  on the host; `--cwd` resolves an existing remote directory the same way. Host,
  remote cwd and base are `agents.host/cwd/base`. The channel is reserved
  before the first remote command and bound to the agent's registry id and
  pane (`admitHostChannel`, `bindHostChannel`); `deleteAgent` and teardown
  free it. `--task` goes through `spawnForTask` (the same receipts, claim and
  incarnation-bound send as a local spawn; the receipt's request hash includes
  the host only when there is one). A failed spawn kills its pane, frees its
  channel and removes only the remote worktree it made, and only while that is
  still clean and at its base. The remote gets five variables
  (`MU_MANAGED_AGENT`, `MU_AGENT_NAME`, `MU_WORKSTREAM`, `MU_CTL_SOCK`, and new
  `MU_REMOTE=1`), never the local DB, state or sync dir, and its extension
  skips the close nudge (no mu DB there; you close). `--root` is refused with
  `--host`; herdr (`runsShellCommand: false`) refuses it in one line (exit 2).
  A failing remote step is exit 5 (`RemotePrepareError`). `mu state` lists
  remote workers from `agents.host/cwd/base` (`remoteWorkers[]` is now
  `{agent, host, path, base}`). Not yet: gate panes with a real exit status,
  detach and reattach.

- **`mu agent collect <agent>` and the remote close rule** (`v_remote_collect`).
  `collect` runs the host's `--fetch` template locally in the current
  directory's git repo, under one channel (at `--max-sessions 1` beside a live
  pane it is refused, naming the holder: the pane is the transport; no detach).
  FETCH_HEAD is cleared first and the commit it holds afterwards is pinned as
  `refs/mu/collect/<ws>/<agent>` and recorded as `agents.collected_head`
  (compare-and-set on id, pane, host, cwd and base); a failed or no-op fetch
  records nothing. It prints `git merge <sha>`, never runs it. `agent close`
  of a `--host --worktree` agent now kills the pane, then removes the remote
  worktree without `--force` only when it is clean and HEAD is the base or the
  collected HEAD. The removal proves quiescence instead of taking a lock (reftable
  ignores `HEAD.lock`): the tree is renamed to `<path>.mu-removing-<id>`
  (every writer addressing the old path fails), `/proc` (else `lsof`, else a
  refusal) must show no process with its cwd or an open file under it, and only
  then are HEAD and cleanliness re-checked with plain git, `--keep-branch`'s
  branch made create-only, and the tree removed. A holder (named by pid), a
  mismatch or a doubt puts the tree back and refuses. A close killed after the
  move is resumed by the retry (the aside name is derived from the row, so no
  record can be lost); it never reports `gone` while the aside exists. Otherwise it
  refuses (exit 4, `RemoteCloseRefusedError`); `--keep-branch` first makes
  `mu/<ws>/<agent>-<sha12>` at the observed HEAD in the remote repo; dirty
  refuses with or without `--keep-branch` and `--discard`. A `--cwd` agent's
  host is never touched. The close preview names the remote worktree (no
  remote command runs). A reaped or torn-down remote row still keeps no
  record: `v_remote_recovery`. A failed collect restores the ref's earlier pin; an
  unchanged collect is fenced by the same compare as a changed one.

- **Agent records are SQL-keyed.** `agent spawn`, `list`, `show`, `me` and
  `state` print each agent with the `agents` column names: `id` (the registry
  **agent incarnation**, what `agent close --if` compares), `workstream_id`
  (the real FK) beside `workstream` (its name), `pane_id`, `command_source`,
  `collected_head`, `created_at`, … The live facts follow, snake_cased and only
  when read: `state`, `source`, `ctl`, `ctl_socket`, `since`, `reason`, `idle`,
  `trust_dialog`. The deprecated `status` column is never printed. An `agent
  close` preview names its identity `id` and `pane_id` (was `incarnation`,
  `paneId`); verb-level keys (`send`, `nextSteps`, `workstreamName` on `list`,
  `revision`, `kind`) are unchanged. The SDK `AgentRow` stays camelCase: only
  the CLI maps (`src/agent-output.ts`). `mu_delegate` reads the new keys in the
  same commit (`agent.id`, `agent.pane_id`, preview `id`/`pane_id`), so a
  delegate still binds its cleanup to the one agent it spawned.
- **`mu agent spawn --task <id> --send <text>` is one journaled attempt**
  (`v_spawn_receipts`): spawn, **claim the task for the new agent**, send the
  text, pin it as the task's `brief` note (kept when one exists: no recursive
  copies, even across concurrent spawns). Each step is written to the new
  machine-local `spawn_receipts` table first (`reserved`, `pane`, `claimed`,
  `sending`, then `sent` or `unknown`; `failed` = definitely unsent), with the
  registry id and pane of the agent it created, no foreign key to `agents`.
  The same command again **replays**: the saved delivery (same `msgId`, `task:
  {replay: true}`), never a second prompt. `--attempt <key>` names the attempt
  (key `manual:<key>`, default the task id); a changed text or name under one
  key exits 4, reopened work takes a new key. A strict per-attempt lock
  excludes a second process (exit 4, `SpawnAttemptBusyError`).
  - Fails before the prompt could be written (ctl missing/refused, Claude's
    trust dialog, a failed claim, an extension that refuses): only the attempt's
    own pane, worktree and claim are rolled back (the existing identity-bound
    guards, unchanged; the claim is released only while the task is still
    owned by that agent and not closed) and the key can run again.
  - Delivery **unknown** (written, no reply; a pane that died after the write;
    a pane paste with no receipt): exit 1, pane and claim are kept (deleting
    the agent would reopen the task for another dispatch), the receipt is
    `unknown`, and a replay asks the extension once (`status {msgId}`) and
    never resends. An id the extension no longer remembers is still unknown.
  - A replay after the agent was deleted or its name reused reports the
    historical delivery with `task.stale` (`deleted` | `replaced`): the
    replacement is never claimed or sent to.
  - Every send after a spawn goes to the **created registry id + pane**, task
    or not: `agent spawn --send` (no `--task`) refuses with one line
    (`AgentReplacedError`, exit 4) when the name holds another agent by the
    time it writes (`sendToAgent`'s `expect`). With `--task`, one immediate
    transaction right before the write re-checks agent id + pane AND that the
    task is still owned by that agent and not closed (also on a resume from
    `claimed`): otherwise `SpawnTaskStateError` (closed/unowned, exit 4) or
    `TaskAlreadyOwnedError`, nothing is sent and only the attempt's own
    resources are rolled back. A fresh attempt on a closed task is refused
    before any pane exists.
  - Those sends are also bound to the **ctl incarnation** the spawn's own
    handshake saw (`SpawnedAgent.ctlIncarnation`, journaled in the receipt):
    the ctl `send`/`fresh` ops take an optional `expectIncarnation` (protocol
    additive, like `wait --inc`) and the extension refuses a mismatch with
    `incarnation mismatch` BEFORE dispatching, so a replacement pi that binds
    the same socket path after the registry check gets nothing (the same
    one-line `AgentReplacedError`; with `--task` it is definitely unsent). An
    extension that reports no incarnation is sent to unbound.
  - Seams: `TransportSendOptions.msgId` (a reserved id for ctl send/fresh;
    the default and `--interrupt` still mint their own), `claimTask`'s
    `expectedAgentId` (checked inside the immediate claim: a name deleted and
    recreated no longer hands the task to the replacement), `releaseTask`'s
    `expectedOwnerId`. `AgentPaneDeadError` carries the `msgId` when a send was
    written before the pane died. `--task` refuses slash/session-command text
    (no ctl receipt) and an already-owned task before any effect.
  - `mu agent check`: `not-accepted` no longer reads "resending is safe": an
    evicted or in-flight send also reads that way.
  - Not in this change (own units): `buildTaskBrief`, `wait_registrations`,
    the executor's `task_auto.last_spawn` attempts, batch spawn.

- **Task reads are bounded records.** `task list`, `next`, `owned-by`,
  `me tasks`/`me next`, `show` and `tree` print one escaped TAB-separated
  record per task or entry (`task id STATE impact=… effort_days=… [owner=…]
  title`, <= 400 characters, never sliced: a long title ends in `…`), and the
  whole result stays within 4 KB, serialized (text lines or the JSON document
  as emitted, escapes, edges, envelope and footer included) and shrunk by
  whole records. A cut ends `more=N cut=N next=<command>`, reserved before
  shrinking so it is never cut. **One way back, everywhere: the same command
  with `--all`** (`--json` kept; `--full` on `owned-by`, whose `--all` means
  every workstream), which prints everything uncapped and whole (every
  record, title, wave, host, neighbour and note; `tree` walks every level and
  CLOSED tasks too). `more` counts records left out, `cut` the characters a
  record clipped. No per-field, per-subtree or `--from` retrieval commands:
  `--from` and `show --edges-from` are gone (`task notes --from` stays).
  `list` takes `--owner <agent|ws/agent>` and `--mine` (the agent's real id,
  so same-named agents of two workstreams never mix). The owner shows only
  while IN_PROGRESS (`owner_id` stays the real FK). `--sort recency|age` adds
  the sorted timestamp. `--json`: items use the SQL column names (`id` =
  `local_id`, `workstream_id`, `owner_id`, `effort_days`, `scored`,
  `dispatch_host`, `kind`, `wave`, `created_at`, `updated_at`, plus `revision`
  on `list`/`show`, `workstream` on `show`/`owned-by --all`), never
  `name`/`workstreamName`/`effortDays`/computed `roi`; `data` is
  `{items,count,more[,cut][,retrieve]}`, and every `--json` document goes
  through the one inert envelope encoder (`encodeEnvelope`: C1, bidi and
  U+2028/9 escaped). `mu state` and `mu me` keep their tables.
  `extension/delegate.ts` and `extension/nudge.ts` read `id`/`workstream`; the
  nudges read uncapped (`--all`/`--full`) and treat a result that still says
  `more` as unknown, not "owns nothing".
- **`task show` is one 4 KB result.** The task is a record (`task id STATE
  … ws= created= updated= rev=`), then one `blocker|dependent id STATE`
  record per neighbour (still-gating first, CLOSED after), then the notes
  records, then one footer. The task record, edges and ordinary notes share
  the cap (the pinned brief, report and verdicts stay exempt); neighbours
  beyond their share, then ordinary notes, then the title are dropped until
  the emitted bytes fit. `--json`: `{task,blockers,dependents,edges_more,notes,
  notes_more,[cut,][retrieve,]lastClaimActor}`; `retrieve` is `show … --all`.
- **`task tree` is the open DAG, in records.** `loadOpenTaskFrontier(db, ws, root?,
  direction?, {uncapped?})` (exported from `src/index.ts`): open tasks expand,
  CLOSED ones are leaves (a CLOSED root still expands), at most 3 CLOSED
  neighbours per node are listed and the rest counted, depth <= 12 and <= 2000
  tasks, diamonds and cycles list once then `again=1`, one SQL read per level;
  `uncapped` lifts every cap and walks CLOSED too (`task tree --all`). Text is
  the task-record grammar: a `tree<TAB>root<TAB>direction<TAB>entries=…` header,
  one `task` record per entry (`depth=N parent=<id>` plus `kids=`/`closed=`/
  `capped=` for what hangs below and is not listed), no branch drawing, no
  colour; the page is a preorder prefix. `--json` is a flat preorder of the same
  items. `loadFullDag` keeps its whole-workstream SDK semantics.
- **Notes default view.** `mu task notes <id>` and the notes of `mu task show`
  print one escaped TAB-separated record per line (`kind n by= at= text`):
  the first `brief`, the last `report` (else the closer's last note, found
  from the `close` note's author at read time), every `verdict`, then the
  last 3 ordinary notes newer than the report. Those three kinds are never
  cut; the other notes are capped so the emitted bytes (text lines, or the
  JSON document with keys and `more`/`retrieve`) stay within 4 KB, pinned
  notes exempt (the output is serialized and the oldest ordinary notes are
  dropped until it fits, never predicted); one bigger than that is a stub (author and text clipped) with
  `cut=` and `next=mu task show <id> --note <n>`. `--all` on a task with no
  notes is an empty result (an explicit `--from 1` still exits 3). A
  trimmed view ends `more=N next=…` (`--all`, or `--from <n>`, pages the
  whole history whole). `n` is the note's 1-based number in its task, local
  to this DB. `--note <n>` on `show` prints one note whole; `n` outside
  `1..total` exits 3. `--tail/--since/--since-claim` keep their meaning.
  `--json`: notes records use SQL names (`n kind author created_at content`),
  plus `more`/`retrieve` (`notes_more`/`notes_retrieve` in `show`). SDK:
  `selectTaskNotes`; `listNotes` stays the full history.
- **Agent guards: `agent close` previews, `--if <rev>` applies.** Bare
  `mu agent close <name>` now writes and kills nothing: it prints the revision,
  the pane, the tasks the agent owns (an `IN_PROGRESS` one goes back to `OPEN`),
  the worktree state and the `--if` command (`--json`: one `{ok,data,next}`
  with `kind` `agent`/`orphan-worktree`/`none`, `revision`, `incarnation`,
  `paneId`, `ownedTasks`, `worktree`, `refusesDirty`). `--if <rev>` closes,
  and a stale one exits 4 with nothing killed (`expected_rev`/`current_rev`).
  An unknown name stays a no-op. A dirty worktree previews with no apply
  command (`--discard` previews the lossy close). The revision
  (`agentRevision`, src/revision.ts) is derived, with no column: a hash of the
  registry **incarnation** (the row's AUTOINCREMENT id, new for every row, so a
  name deleted and created again, even on the same pane id, never matches an old
  preview), the row's fields, every task it owns in any workstream, and its
  registered worktree rows; an orphan worktree has a revision of its own.
  Every agent-row writer now compares identity: `close` re-checks before the
  kill and before the worktree release and deletes by incarnation + pane
  (`AgentReplacedError`, exit 4, leaves a replacement's row, task, socket and
  worktree alone: closing used to delete a replacement registered during the
  kill), and `--worktree` spawn finalize, spawn rollback, reconcile and teardown
  act on the incarnation they saw. Close and `--worktree` staging/rollback take a
  per-agent lock that fails closed (`AgentLockBusyError`, exit 4, nothing done;
  `MU_AGENT_LOCK_TIMEOUT_MS`, default 15000): `withFileLock` gains `strict`,
  which reclaims an aged lock only from a dead holder, under an exclusive
  claim file with a re-probe (two removers never both proceed; an unreadable
  record or a crashed claim blocks), publishes the lock whole by `rename` (a
  failed metadata write is unavailable, never an unlocked run), and releases
  by ownership token. The spawn lock keeps its best-effort behaviour. Round
  two of the review: the close preview reads identity and revision in one
  synchronous snapshot after its git check (a replaced name is retried, then
  refused), the close kill and the spawn-rollback kill re-check the incarnation
  in the step that kills (a replacement on a reused pane id is left alone), and
  a staged `--worktree` spawn unlinks the ctl socket only while its own
  placeholder (own incarnation, still pending) holds the name. Round three:
  the preview reads in one SQLite read transaction (another process's
  replacement cannot land between identity and revision), a spawn rollback
  leaves a pane id any other agent holds, and frees a staged worktree only
  while the registry row at its path is the one that spawn wrote. `mu_delegate`
  keeps the pane and incarnation its spawn reported and closes through
  preview, identity check, `--if` apply; a missing identity, failed preview or
  replacement keeps the pane. Printed `mu agent close` hints now say "preview".
- **Task guards: `--if <rev>` and `candidate_ids`.** `mu task delete`, `block`,
  `unblock`, `reparent`, `claim` and `release` accept `--if <rev>`, the task's
  revision (derived from current state, never a counter: a hash of the task
  row, its owner, every incoming and outgoing edge (hashed in canonical order) and its note count, so a
  peer's synced edge, blocker delete or note moves it too; exact lookups, never
  LIKE, so `a_b` and `axb` do not collide; read after sync ingest, inside the
  verb's transaction). A stale one exits 4 with one line naming the fresh preview and
  writes nothing; `--json` carries top-level `expected_rev` / `current_rev`.
  `task show --json` has `task.revision`, `task list --json` a `revision` per
  item. A `task delete` preview prints `rev` and hints `--if <rev>`; `--yes`
  still applies. A multi-blocker `block`/`unblock` under `--if` is one fence and
  one transaction (a failing batch rolls back); without `--if` it keeps its
  sequential partial success. A wrong task id adds read-only `candidate_ids`
  from the given workstream only (case/`-`/`_`-folded, substring or a typo
  away), also on the unknown-id `delete` and `unblock` no-ops and on `note`,
  `notes`, `update`, `tree`, `close` and `wait` misses and on `task add
  --blocks`/`--blocked-by` misses; nothing writes through a
  candidate. Unknown `unblock`/`delete` ids stay no-ops. SDK: `taskRevision`,
  `RevisionMismatchError`, `ifRevision` on `deleteTask`/`claimTask`/`releaseTask`.
  Agent-side guards are a separate unit.

- **Eval `outside_mux` and `no_mux`.** `outside_mux`: the caller has `TMUX`, `TMUX_PANE` and `HERDR_ENV` unset (setup asserts it); the AUT runs one worker task and a two-claim delegate wave to completion, judged from effects (a worker commit on main, closes after the worker's block, a delegate-recorded verdict before each close, no turn end while work runs, no prod). It has a golden and bads on both families (3.13.3 can do it). `no_mux`: tmux and herdr are off mu's PATH; the AUT does DAG work and the judge runs a scripted check on a scratch copy of the DB: `doctor` and the agent verbs (plus `workstream init`, `state`) refuse with exit 5 and one stderr line naming the install, and task, `sql`, `db query` and `sync` work. 3.13.3 has no `db query`, its `doctor` exits 0 with no refusal, and its other refusals run over several lines: those ten entries are N/A baseline (`lifecycle.native`), listed by `check --verbose`, never a pass. `outside_mux` blanks the sandbox's `MU_MUX=tmux` so mu runs a plain shell's mux detection; `no_mux` syncs into a real scratch dir and requires a segment there. The worker driver treats a `delegate-*` agent as a delegate even though mu-next binds it to its own delegate task.

- **Eval `next` family: ten stable-surface scenarios.** `guessed_flag`, `guessed_sql_column`, `long_notes`, `wrong_id`, `worktree_reuse`, `teardown`, `remote_spawn`, `remote_close_block`, `single_channel_host` and `fanout_gates` have a `.golden.next.json` and the same bad set as 3.x, written against the built checkout (workers close with a CLOSE block and the AUT closes after `agent wait`; remote scenarios store a host profile with `fixtures.hostProfile`, spawn with `--host --worktree --task`, then `agent collect`). The judges accept a worker's `block` as well as `close` in `runs.log`, but only when the task's last close op (`task.close` or a block's `close.apply`) follows it (`closeEarnedWrong` in `fanout_gates` and `worktree_reuse`; three `bad-rv-*close-before-block` negatives); byte-identical `bad-rv7i-*` copies are deleted in both families; the 3.x scripts are unchanged and still pass on 3.13.3. `sshShim` hands `EVAL_DB_PATH` to the remote worker driver because mu-next strips `MU_DB_PATH` from the pane.

- **Eval `next` family: the loop scenarios.** `refute_verdicts`, `delegate_saturation`, `api_outage_resume`, `wait_helper_summary` and `wait_remote_gate` have live `.golden.next.json` and distinct `.bad-*.next.json` scripts against the built checkout (task-bound spawn, `agent wait`, workers' CLOSE blocks, `mu_delegate_reissue` for the calls the queue refused, a host profile for the remote gate). `wait_interrupted`, `wait_mixed_refs`, `wait_wave_six` and `wait_wave_starvation` need the unified `mu wait`: their scripts are `*.next.pending.json` (planned README surface), listed in `PENDING_NEXT`, which `check --family next` skips; the unit that ships the verb flips them (`tools/eval/README.md`, "Pending `next` scenarios"). Harness: a mu-next refusal is a durable non-error `REFUSED` result, so the judges count it as a refusal and a successful `mu_delegate_reissue` as the issue (`refusedNext`, `issuedDelegateArgs`); a faux call can take an arg from an earlier tool result (`argsFromResults`, for the refused call id); the worker driver treats `delegate-*` agents as answerers even though mu-next gives them a task; `api_outage_resume` accepts a CLOSE block as the worker's finish, and `wait_remote_gate` stores the host profile on `next`. Round 2: `wait_helper_summary` and `api_outage_resume` order a worker's CLOSE block against the close (`closeEarnedWrong`; new `bad-close-before-block` and `bad-close-a3-early` scripts, the duplicate `bad-self-wait-after-error` is gone); `test/eval/judges-effects.test.ts` runs every judge against closes that precede and follow a block record and fails if one accepts the early close; `refusedNext` and the reissue match read the tool result's recorded `details` (`state: refused`, `call_id`), the prose only as a fallback. The 3.x scripts are unchanged. Holdouts (`worker_dies`, `wait_receipt_race`) are not touched.
- **Eval: cold-guess probe** (`e_cold_guess`; `node tools/eval/main.ts cold-guess run|check|report`). Not a scenario: 17 one-sentence intents an orchestrator really has (owner of a task, a brief, open tasks blocked by one, close with evidence, spawn and collect on a host, log tail, what awaits a person, add tasks with an edge, reopen, delegates of a wave, a SQL read, stop a worker with unmerged work, what a worker is doing, list workstreams), asked of a model that has only that build's help (no skill, no tools). Its one command runs in a seeded sandbox and a judge reads the state (never the spelling; a stray write is a miss, a lost commit is destructive). `check` proves each judge with a golden, a bad and a no-op on both families. Round 2 (after a review found round 1's `collect` wording leaked next's verb and supplied the whole gap): requests are neutral and linted against every command, subcommand and flag name of both surfaces (`run` refuses a leak); both surfaces get `mu --help` plus every group's `--help`; the 14 pre-registered shared intents are the headline, two controls (`spawn_remote_named`, `add_three_titled`) are reported apart, with per-intent wins/losses/ties. 3 reps x haiku-5-5 + sonnet-5-5: next 92% (77/84) vs 3.13.3 71% (60/84), 3 wins (`agent collect`, `task add` without a score, `--host`), 0 losses, 11 ties; no destructive guess. `mu log --tail 20` writes a record `20` on both surfaces (`--tail` is boolean), though no round-2 guess typed it. Details in `docs/mu-next/eval/cold-guess.md` (rows in `cold-guess.jsonl`); feeds `t_surface` and `v_hints`. No `src/` change.

- **Eval judges assert effects, not command spellings.** The sandbox `mu` shim records
  every invocation (`mu-calls.log`) and tees the AUT's own output; the faux workers log the
  prompts they receive and the delegate answers they serve. Every judge now reads what mu
  and the workers observably did (a call that blocked, a timeout reported in its own
  output, a task observed CLOSED, the ops log's note/close/claim/SQL/teardown ops, a reset
  session, a worker commit that no longer exists anywhere) instead of matching `task note`,
  `mu wait`, `--until-*`, exit 5, `agent send`, `--discard`, delegate refusal prose or the
  tally's format. Prompts that dictated 3.x spellings (`wait_mixed_refs`) name the effect.
  `check` also runs `<id>.golden-<name>` scripts (the same job in another spelling), and
  `verdictFx` adds effect-based destructive entries to every judge: ALL 21 return through
  it (`test/eval/judges-effects.test.ts` runs every judge against a sandbox holding a raw
  write and fails one whose verdict lacks it), and a raw `mu sql` write to a machine-local table (agents, worktrees, ...,
  which writes no op) is caught by the shim's before/after fingerprint of those tables, not
  by the command's words (a write statement in argv counts, so `UPDATE ... RETURNING` is
  caught). `_smoke`'s golden falls back `--workspace` to `--worktree` like the others. The remote goldens apply the `agent close` preview (mu-next's
  close is preview then `--if`), which was the checkout's `single_channel_host` /
  `wait_remote_gate` red. Both 3.13.3 and the checkout keep every verdict (`check` exit 0).
- **Task mutations: batch add, `--blocks`, note aliases, insert-only note
  kinds.** `mu task add [ids...] -t <title> [-t …]` creates several tasks in
  one op group and transaction (one `-t` per id, or ids derived from the
  titles); `--note`, scoring, `--blocked-by` and the new `--blocks <umbrella>`
  (the new tasks block an existing umbrella) apply to all, and a duplicate id,
  missing or cross-workstream umbrella or a cycle rolls the whole batch back.
  Every initial note is kind `brief`. `mu task note` takes `-m/--message/--note/--text`
  (exactly one source), `--report` (kind `report`) and a hidden validated
  `--kind` the pi extension uses to write delegate verdicts (`mu_delegate`
  `record` now files `verdict`, not `note`). `mu task close --note` is an alias
  of `--evidence` (both is a usage error); `--report <text>` stores the report
  first, then the close note, then the status put, in one op group. A report
  is not evidence: a `done` close still needs `--evidence`. SDK: `addTasks` (exported from the package entry; omitted ids derive the next free `_N` suffix inside the transaction);
  `addNote`/`closeTask` accept `group: "inherit"` (join the caller's op group,
  actor and intent) and `addNote` returns `kind`. The `task add` id/title count
  mismatch replaces commander's "too many arguments" error, with the same
  heredoc hint. Note kinds stay set once at INSERT; the reader view is `v_notes`.

- **Schema 13: storage for task-backed delegation and loop provenance.**
  Portable (synced, segment format stays v2; a v1 line carrying `wave` or
  `kind` is refused): `tasks.kind` (`work` default, `delegate`, `human`;
  an unknown value from a newer peer is dropped by the fold, never a CHECK
  failure in ingest) and `tasks.wave` (nullable label); both per-field
  last-writer-wins, captured, drift-checked and rebuilt. Machine-local:
  `agents.spawner`, `host`, `collected_head`, and the tables
  `delegate_calls`, `wait_cursors`, `agent_settles` (no foreign keys, so
  replay evidence outlives the agent and task) and `host_profiles`.
  `spawn` records `agents.spawner` as `<MU_WORKSTREAM>/<MU_AGENT_NAME>` for a
  managed caller, else `pi:<PI_SESSION_ID>`, read from the caller's env;
  never guessed from task ownership. A schema 12 DB upgrades in place on
  its first open (columns, tables, capture triggers (revision 3) and both
  stamps in one transaction; a failure leaves the old file as it was).
  Rebuild reports the four tables' rows as lost like `task_auto`.

- **`mu pi migrate [--apply]`.** A leftover `mu link pi` shim would load a
  second extension next to the package, so this moves only files it can
  prove mu generated, into a `disabled/` folder pi does not read: a file at
  `~/.pi/agent/extensions/mu.ts` that is byte for byte the shim template every
  released `link pi` (3.2 to 3.13) wrote, with only its generated
  `file://…/dist/extension/mu-pi.js` import URL free to differ (no marker or
  import match: a commented import is not a shim), and a symlink at `~/.agents/skills/mu` into this install's `skills/mu` (or a
  copy identical to a released skill, by digest). Never a match on a marker
  or a `name: mu` anywhere else: a user's own `mu.ts` or `mu` skill is
  reported with its path and left alone. Report-only without `--apply`;
  prints restart guidance. The upgrade guide installs the package first
  (`pi install npm:@mu-crew/mu`), then migrates, then reloads.

- Eval harness (`tools/eval/`) and 3.x baseline (`docs/mu-next/eval/baseline-3.13.3-v2.md`; v1 superseded: delegate token, discard parse, send-before-claim, origin and PATH artifacts fixed; v2.1: discard scoring in fanout_gates/worktree_reuse, keyed delegate answers, TMPDIR and an in-sandbox skill copy, `--force` scoring). The scripted scenarios run on both surfaces: spawn falls back from `--workspace` to `--worktree`, so `check` is green on the checkout and on 3.13.3.

- **`mu agent send` returns a receipt; `wait --inc` refuses a restart; `mu agent check`.**
  A ctl `send`, `--fresh` and `--interrupt` carry a fresh `msgId` and return
  `msgId`, `incarnation`, `delivery` (`delivered`; `unknown` in the error JSON
  of a send with no reply, as structured fields beside `error`) and `runs`
  (`--json`); a successful send prints exactly ONE hint (the plain-send
  busy/`--fresh` nudges and the log hint are gone); the `Next:` line is
  `mu agent wait <a> -w <ws> --after-runs <n> --inc <i> --json`. A request
  written with no reply gets one `status {msgId}` probe: accepted is a
  success with `receipt: "confirmed-after-timeout"`, otherwise
  `AgentSendIndeterminateError` (exit 1, carries `msgId`, Next
  `mu agent check`); it never resends. New verb `mu agent check <agent>
  <msgId>` (`accepted runs=<n> at=<iso>` 0, `not-accepted` 3,
  `unreachable` 1; `--json`). `mu agent wait --inc <i>` raises
  `AgentRestartedError` (exit 4) on a mismatch reply or a reconnect that
  finds another incarnation (`waitForAgents` now propagates a rejected
  watch); `abort`'s wait carries the incarnation too. Before it relies on
  `msgId` or `incarnation`, the CLI asks `hello` (once per verb): a pi that
  loaded an older mu is refused with `AgentExtensionOutdatedError`, whose
  steps are ctl `/reload` (slash commands themselves are exempt), the mux
  reload line (`MuxBackend.reloadCommands`, herdr), then close + the spawn
  line rebuilt from the agent row. Machine-local `agents.command` and
  `agents.command_source` (in v12) record how a pane was started. The
  extension-less interrupt fallback (abort, wait, send composed by the CLI)
  is removed. `spawn --send` reports `msgId` and `incarnation`. `hello` lists `features`
  (additive; protocol v1).

- **mu-next surface contract (docs only).** `docs/mu-next/surface-contract.md`
  holds the planned contract and the unit that delivers each part;
  VOCABULARY gains a "Planned terms" section; the mu-next README says
  which sections are planned, and records that the `dec_*` spelling
  tournaments were dropped (the README defaults stand). Nothing in the
  CLI changed.

### Changed

- **Delegate answers arrive through the settle wait; the pi echo is gone (`v_settle_delivery`, Settle
  B).** An answer used to travel twice: the wait's `delegate` event (no answer text) and a pi follow-up
  echo carrying the whole answer, with its own in-memory delivery identity, copies under
  `~/.cache/mu/delegate-answers/`, an "already handled" stub for repeats and a delegate answer that
  cancelled a running settle wait. Now the call id is the one identity and the wait's cursor is the
  delivery: when the settle wait returns a `delegate` event, the continuation carries that call's
  report (its task note, capped at 4000 characters with the `mu task notes` pointer; a recorded check
  with a verdict is the header only). A delegate of a wave keeps the same wait running while siblings
  are pending and then shows ONE **wave summary** (counts, a line per call, the answers); refused
  calls are listed for reissue, never waited on; any other event ends it early and follows the
  summary. The delegate side sends a pi message only as a **wake**: one pointer per answer, no
  answer text, when no settle will show it (pi idle, `MU_NUDGE=0`, the wait failed). The settle
  tells it which answers it showed (`DelegateHandle.delivered`, which replaces `onAnswer`); a wait
  that found nothing owed covers every answer recorded before it started. A wake lost from pi's
  queue is resent once; lost twice or dropped by Escape it leaves one line per answer and no turn.
  The settle hold splits into `input` / `wake` / `blocked`: any of them skips a wait's start, none
  discards a consumed result's entries. A run with no final answer records its words (outcome,
  error, what to do, session, partial text, pane tail) as the report; a record that fails still sends
  that one answer whole. A mux-free delegate (`mu delegates run`, which records the call itself) is
  owed and woken the same way; its follow-up wording (`processMessage`) is gone. Unchanged: record-before-close, `answerPending()`, and `murmur:pending`
  `{source: "mu_delegate", count}` (running + starting + queued; wakes never count). Removed: the
  `delegate-answers` cache dir, `droppedAnswersDir`, the stub, `partialCopy`. Tests: the echo, stub and
  copy cases became wake, replay, loss, hold and wave cases; `extension-delegate-pi.integration.test.ts`
  runs a real `AgentSession` with the real settle wait and `dist/cli.js` (starvation, wave summary,
  Esc mid-wait, `MU_NUDGE=0`). Code: `extension/nudge.ts`, `extension/delegate.ts`,
  `extension/delegate-format.ts`, `extension/mu-pi.ts`.

- **Final docs pass on the merged surface (`v_docs_final`).** `mu --version` prints
  `4.0.0-next.0`, so a checkout no longer reads like the installed 3.13.3 (dogfood-1 F4).
  Every verb's `--help` description is at most 3 lines at 80 columns, pinned by the new
  `test/help-budget.test.ts` (22 verbs trimmed; the dropped detail lives in `docs/guide/`).
  `mu wait --help` names `cursor`, and its `--resume` says that only a matching `-w` may be
  added, as the printed `resume` handle does (dogfood-2 F3, F4). The surface contract states
  what ships and names the two units still landing (`v_settle`, `v_delegate_nomux`) instead
  of a stale "kernel today" list; ARCHITECTURE gains `src/close-block.ts` and
  `src/cli/sync.ts` and drops the deleted `printNextSteps`/`paneNotFoundNextSteps`;
  VOCABULARY's "planned" section is retitled, now that it ships; the guides, VISION and the
  architecture pages say `mu wait` where they said `mu task wait`/`mu agent wait`, and the
  dispatch guide says to follow `resume` after one death when two owners die (reviewer-6). The
  README gains a Status line. This Unreleased section repeated its headings (3 Added, 5 Changed, 3 Removed, 2 Fixed
  blocks); they are merged. `test/wait-dead-after-reap.test.ts` adds the
  reap-reclaim-reap case that kills the surviving `prior?.ownerId || 0` mutant.

- **The capped skill ships (`v_skill_ship`).** `skills/mu/SKILL.md` goes from 2,477 to 596 words and the
  26 recipes (15.5k words) become 12 of at most 250 words each (2,823 together; cap 4,000): orchestrator-loop,
  brief, tasks-or-calls, findings, adversarial-review, test-health, models, remote-workers, recovery, worker,
  course-correct, move. The dropped recipes (ultrathink, plan, fan-out, loop-until-done, refute, review-panel,
  tournament, hypothesis-panel, deep-research, rules-audit, waves, long-run, drift-audit, watcher,
  backlog-triage, codemode-driver) live in git history; the nine `prompts/` now point at a shipped recipe and
  carry their one-line shape. `docs/mu-next/rule-destinations.md` records where every 3.x rule went.
  `test/prose-budget.test.ts` pins the word caps (the `wc -w` tokenizer), the recipe index, prompt targets,
  retired-surface absence and six failure-backed markers (keep-driving, record, remote-collect,
  error-receipt, reviewer-evidence, claim-before-send), each checked to fail when its guard is deleted;
  `test/docs-cli-drift.test.ts` discovers recipes and prompts by directory and validates their `mu` snippets.
  Prose, tests and links only: no `src/` change beyond one comment path.

- **The keyed message table (`v_hint_messages`, slice C of `v_hints`).** Every error line, usage
  refusal, warning and stderr hint of the task, agent, db, mux, sync, host, remote, workstream,
  worktree, log and delegate domains is a function in `src/messages.ts` (`MESSAGES["task.parked"]`,
  rendered with `say(key, ...facts)`), so `t_errors` rewrites one line at a time. Wording, typed
  classes, exit codes and structured fields are unchanged. The `UsageError` sites of `cli.ts`,
  `cli/{wait,delegates,db-query,log,me-identity,host,sync,db}.ts` and the run-time hint strings of
  `handle.ts`/`doctor.ts` are the remaining inventory.

- **The keep-driving nudge is now the settle wait** (`v_settle_wait`, slice A of `v_settle`). Every
  completed settle of an orchestrator pi runs the one wait, `mu wait --first --on-stall exit --json`,
  as its callers (the inherited managed identity plus `PI_SESSION_ID` from the session, passed through
  a per-call child env), and continues the turn with the wait's own result under the SKILL.md rule.
  No shell line is parsed (producers arm the wait from state) and there is no once-per-prompt latch.
  The turn ends only when nothing is owed (`WaitNothingError`, or `drained`), a `mu human-needed`
  stop is open (read per identity with `mu state --me` before each wait, and in the result), the
  user cancels (Esc, typed input, a dialog, shutdown), or the wait fails, which is shown and never
  read as "nothing owed". A heartbeat timeout with work still owed waits again. A delegate answer
  on its way cancels only the settle wait (`DelegateHandle.onAnswer`); the answer's own settle waits
  again. A cancelled wait drains: the runner's one terminate path (SIGTERM, resolve once the child
  exited, final stdout kept; also what rolls back a cancelled spawn) with a SIGKILL after 3 s here
  (`MuRunOpts.drainMs`, default 10 s). A wait result consumed while an answer queued keeps its
  entry and drops only its continuation. Removed: `dispatchedWorkstreams`, `shellSegments`,
  `nudgeText` and the `mu task list --status IN_PROGRESS` read. Skipped on a remote host
  (`MU_REMOTE=1`) and in a nested pi; `MU_NUDGE=0` still turns it off.

- **One wait hint.** The `Next:` line after a send, `spawn --send`, `spawn --task` and
  `send --interrupt` is now `mu wait 'agent:<ws>/<name>@<runs>#<incarnation>'` (one POSIX-quoted
  typed ref, no `--json`: `mu wait` always prints JSON, the answer is `snapshots[].lastText`),
  replacing `mu agent wait <a> -w <ws> --after-runs <n> --inc <i> --json`.

- **Dashboard drills** (`v_dashboard_drill`): Enter opens a read-only full-screen body: Tasks the
  task's notes (the CLI's default selection, pinned notes marked `*`; `A` shows all, whole), Agents
  the pane scrollback (last 2000 lines, `r` reloads), Log one op with every field. `j/k`, PgUp/PgDn,
  `g/G` scroll (clamped, wrapped by visual width, no ANSI in the text); Esc or `q` returns to the
  tab with its filters and cursor. `y` copies the row's command with OSC 52 (no clipboard
  dependency) and prints it; control characters and over 1 KB are refused. `a` on an agent is the
  one key that runs anything: the backend's `attachCommands` steps, in order, with Ink's terminal
  suspended and restored (`$TMUX` picks `switch-client` or `attach-session`; `-L` routing kept). A
  failed required step stops, an optional one is a warning; no mux, no workspace or no client opens
  the scrollback with the reason and the attach line for a shell outside the mux (yankable).
  Typeahead typed during an attach is dropped. A drill's failure reason, outside-client line and
  yank confirmation are pinned under the title (at most half the screen), not part of the scrolled
  body, so a long scrollback that opens at its end still shows them. `AttachTarget.outside` asks a
  backend for the line to run from a shell outside any client: herdr then always appends the
  client step (inside herdr the executed steps stay focus-only). Adds `DashboardRuntime.notes` (read-only
  connection). Read-only otherwise: no task or agent mutation.
- **Dashboard tabs** (`v_dashboard_shell`, slice S2): the dashboard shows a workstream row and
  four tabs: Tasks (newest activity first, CLOSED hidden, owner on IN_PROGRESS), DAG (the open
  frontier; root, repeat and per-entry cap cuts always listed, even when a text filter hides the
  entry), Agents and Log (every workstream, scratch
  marked `*`). Starts on `-w`, else the mux session's workstream, else the most recently active one
  (never the alphabetical first). Status (`s`) and text (`/`) filters persist per tab and
  workstream; the cursor follows its row key, not its index, so activity reordering never moves
  it, including the default row on first view and after a filter reset. A short or narrow
  terminal keeps the workstream row and tabs (then one data row, filter, hint, Next); tabs
  collapse to the active one when four labels do not fit. Next reads `unavailable` until the Next slice computes it (never "no authorised work");
  an agent whose tool is not reported shows `tool ?`. The runtime now runs one refresh at a time
  across queries: a changed query waits for the in-flight one. Read-only.
- **Dashboard shell boot** (`v_dashboard_boot`): bare `mu` on a TTY (stdin and stdout, no `--json`)
  opens the dashboard; a pipe, script, `--json` or `--help` prints the same help as before. Adds
  `ink` 8 and `react` 19 (no devtools), `jsx: react-jsx`, and a lazy UI chunk that neither the SDK
  index nor any other verb loads. The UI reads on a `readonly` connection; ambient sync (ingest at
  most every 10 s, quiet, one refresh in flight, no reconcile or reap) runs on a separate bounded
  writable connection outside render, with the DB-inside-`MU_SYNC_DIR` and sync/v1 refusals kept
  and one idempotent shutdown (installed before the lazy import) that restores the terminal, closes
  the connections and flushes once on `q`/Esc, SIGINT (exit 130), SIGTERM, SIGHUP, uncaught and boot errors. A read-only connection cannot ingest, so one
  connection was not an option. The shell shows counts only; tabs and rows are `v_dashboard_shell`.
- **Dashboard read model** (`v_dashboard_core`): `loadDashboard(db, opts)` (`src/dashboard-data.ts`,
  exported from the SDK) is the one read-only projection the dashboard tabs share: every live
  workstream (scratch included), all tasks by status (CLOSED hidden by default, uncapped when
  asked) under `<workstream>/<id>` keys ordered by raw `MAX(ops.seq)` activity, the open
  frontier, registry agents with their owned task, the canonical op log, and the caller's own
  human needs and delegate calls (a null caller sees none: `caller_scope: "none"`). It never
  reconciles, reaps, ingests or writes, and runs on a `readonly` connection. `next` is
  `computeNext` (see `v_dashboard_next` below). Owners are identified by agent registry id (`owner_id`, with
  `owner_workstream`; a task claimed by another workstream's same-named agent lands on that
  agent, also on a filtered read), and the open frontier's root/recurrence cuts pass through as
  `frontier[]` per workstream.
- **Dashboard Next and running tool** (`v_dashboard_next`): `loadDashboard`'s `next` is
  `computeNext` for the caller set (`next_source: "computed"`, so null now means "no authorised
  work"; `"unavailable"` only if it throws), and the dashboard passes `currentCallers()`. The pi
  extension's ctl `status` gains an optional `tool: {name, since} | null` (innermost running tool,
  cleared on settle; additive, no new op or feature), which `ctlProbe`, `readAgentStates` and
  `readLiveAgents` carry. An agent's `tool` is `{name, since, elapsed_ms}` (elapsed at read),
  `null` (none running, shown `tool -`), or absent (old extension or no ctl, shown `tool ?`).
- **`mu wait`: the one orchestrator wait** (`v_wait_surface`, slice A of `v_wait_cli`; over the
  `waitForEvents` engine). `mu wait [<ref>...]` returns on the first event its caller owns and
  prints ONE JSON document with no `--json` flag, errors and parse-time errors included. Refs are
  typed: `task:[<ws>/]<id>`, `agent:[<ws>/]<name>[@<runs>][#<incarnation>]`, `delegate:<call id>`
  (a bare word is refused with the spelling that works). No refs: the wait owns what the caller
  started (the agents it spawned, by `agents.spawner`, and their tasks; its delegate calls).
  `data` is `firing` (= `event`: `kind`, `ref`, `incarnation`, `runs`; `closed settled input dead
  stall delegate pane-text heartbeat interrupted`), `exit` (0, 6 dead, 7 input or stall, 130/143 signal),
  `timedOut`, `interrupted`, `open`, `snapshots`, `tally` (with a `6/12 CONFIRMED` summary),
  `cursor`, `resume`. A timeout is `ok:true`, `timedOut`, exit 0. SIGINT/SIGTERM print the final
  snapshot (the state read at that moment) and `resume`, then exit 130/143; SIGKILL cannot print.
  The result is bounded to 4096 bytes on its FINAL bytes, `nextSteps`, `humanNeeds` and `warning`
  included: texts shrink first (tail kept, `lastTextCut`), then the hints (`nextStepsCut`) and
  human needs (`humanNeedsCut`), the tally's findings, and the snapshots (`snapshotsCut`,
  `retrieve`; the shared `pageRecords`); firing, exit, open and resume are never cut. `resume` is a
  stored handle, `mu wait --resume <id>` (+ `-w`): the new machine-local `wait_resumes` table holds
  the refs still owed (each agent with the run baseline and pi incarnation it was last SEEN at, so a
  restarted pi is refused, not miscounted), mode, every filter, the deadline as given and the
  callers the wait ran for, so a resume is lossless whatever its size (30 refs, 24 was the old
  silent cut) and runs for the same caller from any shell. `--resume` takes nothing else (a flag or
  ref beside it is a usage error); an unknown or older-than-14-days handle is exit 3. With nothing
  left to wait for and no caller (a plain shell whose named refs all fired) `resume` is `null` with
  `resumeWhy`, never a command that fails. Flags: `--first`/`--first-of`
  (default), `--all`/`--all-of`, `--until-idle`, `--until-text <re>` (the bounded regex; a pi
  agent's ctl `lastText`, never its pane. A non-pi pane (no answering socket) has no run to settle:
  its tail is matched and the wait ends as the distinct `pane-text` event, `textSource: pane`, never
  `settled` and never a CLOSE source), `--status`, `--stuck-after`, `--on-stall exit|warn`
  (`steer`/`release` arrive with the stall-action units and are refused by name), `--wave`,
  `--blockers-of`, `--timeout` (default and cap 1500 s; 0 = the cap; one warning when below 300 s),
  `--after-runs`, `--inc`. One stderr heartbeat line a minute; never ANSI. The engine gains
  provenance discovery of a caller's spawned workers, a `scope` that narrows what a caller owns to
  one workstream, owner-death detection for a plain-shell wait, and `onStall: warn`.

- **BREAKING: `mu task wait` is now an alias of `mu wait` over task refs.** It prints the one JSON
  result (no `--json` needed) instead of the table and the old `{firing, all, timedOut[]}` shape;
  the default is the FIRST event, not all-of (`--all` keeps the all-of loop); `--any`, `--first` and
  the default are one contract and always name the firing ref; the default timeout is 1500 s (the
  cap; `0` means the cap, no longer forever; it was 600 s); a timeout is `ok:true` with `timedOut`
  and exit 0, no longer exit 5; the reaper flip and the stall are events (`dead`, `stall`) in the
  document, no longer stderr text and a thrown error. `--on-stall warn` still keeps waiting and now
  prints one stderr line per stalled task. The help example `jq -r .firing.qualifiedId` is now
  `.data.firing.ref`.
- **`mu agent wait --any` fills `firing`** like `--first` (one contract). Its output is otherwise
  unchanged: the delegate recorder (`extension/delegate.ts`) reads `data.agents[0]` as before, over
  the same engine with `eventScope: refs`.
- `mu wait` and `mu task wait` default to JSON (`isWaitVerbArgv`, verb-aware like `state`), so a
  parse-time error is one stdout document too. `handle()` drains stdout before `process.exit`, so a
  piped result is never truncated.
- The poll-sleep test seam is shared by every wait entry point (`setWaitSleepForTests`).
- **mu-next is isolated from 3.x on disk** (`v_isolation`; after the 18:04 incident, where an
  inherited `MU_SYNC_DIR` let a mu-next run write a v2 segment into the real 3.x sync folder
  and 3.x warned `unknown-version` on every command). The default state dir is now
  `$XDG_STATE_HOME/mu-next` (`~/.local/state/mu-next`), holding the DB, control sockets, locks,
  worktrees and compile cache; `MU_STATE_DIR` and `MU_DB_PATH` are unchanged. Sync stays opt-in,
  but mu-next refuses a `MU_SYNC_DIR` where any file is 3.x evidence: a `*.jsonl` segment opening
  with a v1 line, or a `*.manifest` with `"v"` below 2 (a 3.x peer with no ops yet leaves an empty
  segment and a v1 manifest). Read and write: exit 4, `MU_SYNC_DIR holds 3.x segments; give
  mu-next its own dir`, nothing read or written (`SyncDirForeignError`; checked in `handle()`
  before the DB opens and again inside `flushSegment`, `discoverPeers` and `ingestSegment`
  themselves, so SDK callers are covered). The vitest real-DB guard and the global teardown
  now cover both the mu-next and the 3.x default DB paths. Remote worktrees move to
  `~/.local/state/mu-next/remote-worktrees`.
- **mu-next design: a model-run move recipe replaces the import and the flag day.**
  mu-next runs beside 3.x with its own DB, state, sync dir and machine id; the 3.x DB
  stays a read-only archive and workstreams move one at a time
  (docs/mu-next/README.md, Move). Docs only.

- **Root `-w` reaches every verb as its own shape** (`bug_delegates_global_w_not_a_string`):
  `mu -w auth delegates tally --wave w1` (and `delegates register`) died `value.trim is not a
  function`, because `optsWithGlobals()` let the root's raw array overwrite the verb's `-w`. The
  forwarding hook now settles the root to what the verb holds. A test walks every verb with a `-w`.

- **`mu log --tail 20` no longer writes** (`bug_log_tail_n_writes`): `--tail` is a boolean, so the
  guessed `20` was logged as text. A positional with a read flag (`--tail`, `--all`, `--since`,
  `--after`, `--seq`, `-n`, `--source`, `--intent`, `--group`) now exits 2 and writes nothing; an
  integer gets "did you mean -n 20?".

- **`mu state` and `mu me` are one canonical JSON document** (`v_state_log`, slice A). `mu state` no longer prints a card:
  by default (no `--json` needed; errors included, parse-time and handler) it prints one envelope
  `{ caller, me, workstreams: [...] }`, one entry per workstream (`-w a,b` / `-w a -w b` / `-w a b` / `--all`, one name is
  still an array of one) with `counts`, `ready` (ROI order), `in_progress` / `blocked` / `triage` / `recent_closed` (newest
  activity first: raw `MAX(ops.seq)` over the task's own, its notes' and its edges' ops, so a `mu sql` write counts),
  `agents` (the registry record, `host`, `cwd`, `base`, `collected_head` included, with its runtime state; unknown stays
  unknown), `orphans`, and **the caller's own** `delegates` (unfinished calls), `waves` (tally of its own calls only) and
  `human_needs`. Keys are SQL column names (`workstream`, `effort_days`, `recent_closed`; the camelCase `workstreamName`,
  `inProgress`, `tracks`, `recent` ops and `remoteWorkers` keys and the `--events` flag are gone: `mu log` owns the ops).
  The read is capped at 4096 final bytes: every string is one escaped line of at most 160 characters, lists shrink, then
  whole workstreams page; a cut says `more=N` / `cut=N` and `retrieve` names `mu state ... --full`, the uncapped read. `mu state -w`
  reconciles first (reaps gone panes, lists orphans); `--me` and the SDK read never touch the mux. The last fallback is
  checked too: when nothing fits, a zero-workstream envelope whose `retrieve` is the short `mu state [--me] --all --full`
  (when the scope names are too long) and whose strings shrink below 160 characters until the final document fits.
  **`mu me` is exactly `mu state --me`** (bare `mu me` now runs instead of printing help; `me --include-closed` is gone;
  `me tasks` and `me next` stay, `--json` explicit). Identity is the injected `<MU_WORKSTREAM>/<MU_AGENT_NAME>` row looked
  up in that workstream, else `pi:<PI_SESSION_ID>` (a session has no agent row; its scope is where it has delegate calls or
  human needs); `$TMUX_PANE` identifies nobody on this path, and no identity is a one-line `UsageError`. `isJsonMode` also
  defaults `state` and bare `me` to JSON. SDK: `stateSnapshot`, `callerWorkstreams`, `readLiveAgents` (the read-only half of
  `listLiveAgents`) and the `State*` types are exported; `verdictTally` takes an optional caller; `listRemoteWorkers`, the
  track/ready/log card renderers and `scratchIdleNudge` are removed (the `WorkstreamSnapshot` loaders stay for doctor).
  A workstream past 300 tasks and under 10% open carries a `hint`.

- **`mu log` and `mu workstream list` are capped records.** Text is one escaped
  line per visible op (`log<TAB>seq<TAB>time<TAB>source<TAB>scope<TAB>what`, at
  most 400 characters; the parent-row touch an add-note writes stays hidden, as
  before) and one line per workstream. A result is at most 4 KB on its final bytes;
  `more=N next=<same read, continued>` and `cut=N next=<lossless read>` name the
  way back **by seq, never by filter**: `mu log --seq 5..9,12` (exactly those ops, each
  whole; no `-w`, no filter, nothing inherited from `MU_WORKSTREAM`) when the omitted ops
  are a few runs with no other visible op between, else `mu log --after <seq>` (the whole
  log, paged, from there). No filter, group or workstream name is ever echoed into a hint,
  so a hint is digits only and always fits, and a malicious historical group id cannot
  reach a shell. `mu workstream list [--torn-down] --all` reads a workstream page whole.
  Every JSON item, fixed fields included, is
  bounded to 2 KB, a page keeps no record when one would bust 4 KB, and the torn-down
  list's `Next:` block counts in the 4 KB. `--json` items use the
  `ops` column names (`key`, `actor`, `entity`, `group_id`, `created_at`, plus
  `rendered`), not `workstreamName`/`source`/`kind`/`group`/`createdAt`; clipped
  fields count into the item's `cut`. A log write answers with one such item; its text
  receipt is the same escaped, clipped record the log shows (plus `cut=N next=mu log --seq <n>`).
  `workstream list` gains `--all` (every row whole, no field clipped). The old tables are gone.
- **`mu log --tail` is always NDJSON** (no header line, `--json` not needed): one
  item per line, each bounded like a `--json` item with a `retrieve` command when
  it clipped something (`mu log --seq <n> --json`). Rows are written before the cursor moves (a failed write ends the tail with the seq it reached); SIGINT exits 130
  and SIGTERM 143 with every polled row already on stdout.
- **An op of an intent this build does not know prints as what the row says**:
  `op put|del <key> intent=<i> kind=<entity> patch=<fields>` (a prose payload
  follows). It no longer turns `workstream.delete` + `put` into a "workstream
  delete". `close.apply` is a known intent. `renderOp` no longer clips free text
  (note bodies at 60, prose at 120): the output boundary clips and counts.

- **`mu db query` replaces `mu sql`; `mu sql` stays as the same verb.**
  In-process SQL on the capture path, as before (one `sql.write` group,
  `--confirm-rows`, sync ingest before and flush after, even on error), now
  with `-w` scoping `ready`/`blocked`/`blockers` to one workstream (per-connection
  `TEMP` views carrying the resolved workstream id as a literal; same columns;
  torn-down filtering kept; `main.ready` is still the global view; a spawned
  worker defaults to its own). `no such column` is one line (exit 2) naming the
  closest columns and the real columns of the tables the query names. A
  non-positive explicit id is a one-line usage error. `mu db --shell [-w ws]`
  runs `sqlite3 -readonly -safe` on the DB with the same views. `db backup`,
  `compact` and `forget` stay. Hints in errors, `doctor` and `drift` now teach
  `mu db query`. Not changed here: rows still print as a table without
  `--json` and are not capped.
- **SQL cannot disable or forge capture (rv6_sql_ctx_tamper).** `mu db query`
  refuses by policy, not by detection: no `CREATE`/`DROP`/`ALTER` of any kind
  (`TEMP` triggers, views and tables included: a `TEMP` trigger on `op_ctx` ran
  inside the scope's own reset and could forge `ops` or leave `applying=1` at
  rest), no `ATTACH`/`DETACH` (a peer or backup mu DB was writable through
  `peer.ops`), no write to `op_ctx`, `op_dying`, `ops` or `schema_version`.
  SQLite's `EXPLAIN` listing, trigger bodies included, decides, never a regex;
  better-sqlite3 has no authorizer callback. Need DDL: `mu db backup` and
  `sqlite3` on the copy.
- **Only read-only PRAGMAs run.** SQLite applies a PRAGMA when it compiles it,
  even in a statement that then fails, so the allowlist (`table_info`,
  `index_list`, `foreign_key_list`, bare `user_version`, `foreign_keys`,
  `busy_timeout` and a few more) is checked on the statement's first tokens
  before the compile. Anything else is a one-line refusal.
- **`mu db -w a query` honours the `-w`** (it was bound to the `db` namespace and
  dropped, so the query ran on the global views). A second, different `-w`
  after the verb is a usage error; other `db` subcommands refuse it.
- **`; BEGIN` is refused (rv6p2_sql_leading_semicolon).** Leading `;`,
  whitespace and comments are skipped before the transaction check, and a
  statement SQLite cannot list now fails the call instead of passing it.

- **Capture UPDATE triggers are a flat `json_group_object` over the
  changed columns.** The nested-CASE form doubled the trigger text per
  column (two columns took `_cap_tasks_upd` from 274 KB to 1.09 MB, +12 ms
  on every `mu` start); payloads are unchanged.

- **`mu doctor`'s `mu ext` row is live.** It reads `hello` (`extVersion`,
  ops, features) from the pi agents' control sockets; with no pi agent it is
  `unknown` (ok), never inferred from a file on disk. The `mu skill` row is
  gone (hello cannot prove a skill loaded). Advice that said `mu link pi`
  now says `pi install npm:@mu-crew/mu`. `CtlProbe` keeps `hello.features`.

- **`--json` prints ONE envelope document on stdout, errors included.**
  Success is `{"ok":true,"data":<old payload>,"next":null}`; failure is
  `{"ok":false,"error","message","next":null,"exit":<n>}` on **stdout** with the
  same non-zero exit (stderr stays empty, no ANSI), so `2>/dev/null` loses
  nothing. The old `exitCode` is `exit`; the legacy `nextSteps` list stays
  (inside `data`, and beside the error fields) until per-verb `next` plans
  land. A usage error's `usage` is at most 3 short lines (synopsis, options,
  subcommands), not a JSON help tree. A verb that fails after producing
  evidence prints one failure document with that evidence in `data`:
  `doctor` (drift, hazard FAIL, no multiplexer: the report is `data`, no
  second document), `agent spawn --send` (the spawn and the nested
  `send.ok:false`; the `msgId`/`incarnation`/`delivery` receipt of an
  indeterminate send stays structured beside `error`), `agent check` (the
  verdict is `data`). `mu log --tail --json` stays raw NDJSON, one op per
  line. Wait exit codes and `timedOut` payloads are unchanged (owned by the
  unified wait). The `mu_delegate` and nudge extensions read the envelope.
  New pure `src/output-contract.ts` (`encodeEnvelope`, `capRecords`: UTF-8
  byte budget, cut on a record boundary, first and pinned records never cut);
  test helpers `runCliJson` (unwraps `data`) and `runCliWire` (raw).
  Part B (tests only): every test that parsed `--json` stdout/stderr moved
  onto `runCliJson`/`asJson` (or the raw `runCliWire` for wire assertions);
  `runCli` is now the raw capture (human output), the transitional legacy
  view is gone. Test counts unchanged.
  Round 2: root-position `mu --json <verb>` now prints the envelope on
  success too (it only worked on errors); `mu log <text> --json` prints the
  written row (with `rendered`) as one envelope; under `--json` the warnings
  that went to stderr (`agent spawn` ctl-missing / trust dialog, whitespace
  or bare `-` notes, `agent wait` state unknown, `mu sync` lock busy, ambient
  sync asides, `task wait` stall line, herdr unconfirmed send, `db` drift
  line) are in the document's `warnings` (spawn, `task note`,
  `task add`, `task close`/`accept`) or dropped where the document already
  carries the fact (`unknownReason`, `stuck`, `delivered`); `agent remote-env
  --shell --json` is a usage error (exit 2), never shell text. One
  table-driven test (`test/cli-json-wire-matrix.test.ts`) walks every
  registered verb in leaf and root position.
- **Scope is explicit: `-w`, a qualified ref, or a worker's injected identity.**
  `$MU_SESSION` is no longer read and the mux session name never routes a
  verb. A verb with no scope fails with one line, no help dump, exit 2:
  `no workstream: pass -w <name>` (inside tmux it adds the session as a
  suggestion, `(tmux session mu-auth: -w auth)`; `state` and `log` add
  `or --all`). A managed worker (`MU_MANAGED_AGENT=1`) keeps its injected
  `MU_WORKSTREAM`. A bare ref that exists in one workstream is no longer
  guessed (the error names `<ws>/<name>`); in several it stays
  `NameAmbiguousError`. `mu state` and `mu log` (read and write) need a
  scope or `--all`; `state --json` no longer prints an empty success.
  `-w ''`, `-w ' auth'` and `-w 'a, b'` are usage errors everywhere (root
  `-w`, `state`, `optsWithGlobals` verbs, every `resolveWorkstream`) instead
  of being trimmed into another workstream; only a structural comma
  artifact (`-w 'a,'`) is dropped. One validator (`src/workstream-scope.ts`,
  never trims) serves every path: CLI `-w`, the `<ws>` of a qualified ref
  (` own/t` and `/t` are errors), `task wait` (an explicit `-w` is checked
  even when every ref is qualified), `mu_delegate`'s `record`, and the
  nudge parser. A scope value holding whitespace, a comma or a slash is
  one name pasted wrong, so it is refused (`-w 'own, decoy'` included);
  `--for <ws>/<agent>` and `$MU_WORKSTREAM` go through it too. Scope errors
  (conflicts included) are one line with no help dump, from the root
  `-w` hook too; one table test feeds the same bad values to every entry
  point. Identity: `mu me`, `me tasks`, `me next`
  and `mu log` source/partition read `MU_AGENT_NAME`/`MU_WORKSTREAM` first
  (no `$TMUX_PANE` needed; a managed identity with no agent row is an
  error, never a pane guess); `$TMUX_PANE` is the fallback only without an
  injected identity. Claim and note authorship were already
  `MU_AGENT_NAME`-only: the stale pane-title help text is gone. `mu doctor`
  drops `$MU_SESSION` and reads no workstream from the session (per-workstream
  stats only for an injected scope), and with no working multiplexer prints
  its report, then exits 5 (`--json`: the report on stdout, the error
  envelope on stderr). `NoMultiplexerError` is one line naming the install
  (`--json` keeps its `nextSteps`). EVERY `mu agent` verb needs a multiplexer
  (a `preAction` gate on the namespace): `agent show` and `agent remote-env`
  used to print with none. Task, DAG, wait and `sql` verbs work with no
  multiplexer. pi extension: `mu_delegate` `record.task` must be `<ws>/<task>`
  or come with `record.workstream` (refused before anything spawns; a blank
  or padded `record` scope is refused, never trimmed); the keep-driving
  nudge reads the scope as the CLI does (root `-w`, verb `-w`, a qualified
  `<ws>/<agent>` or `<ws>/<task>` ref, explicit over injected; an invalid
  explicit scope dispatches nothing) and no longer reads or logs without
  one (no scope counts only for a managed pi, as its injected workstream).
  Docs: README quick start and `docs/reference/env.md` drop `MU_SESSION`.

- Test health, kernel milestone: slow tests sped up without dropping assertions (fast 19.6 s -> 13.5 s, slow 3m14s -> 2m32s; counts unchanged); `docs/ARCHITECTURE.md` module map and `docs/test-health/2026-10-24-kernel.md`.

- **`workstream teardown` is soft and needs a preview revision.** Without
  a flag it prints counts and `rev=<n>` and writes nothing. `--if <n>` kills
  the session first, deletes the machine-local agent rows and sets
  `torn_down_at`, in one op group (`workstream.teardown`). Tasks, edges and
  notes stay and are hidden: every view, `list`, `state` and `-w` verb says
  `workstream <ws> is torn down (at <iso>)` (exit 3,
  `WorkstreamTornDownError`). `--if` refuses with exit 4 (`workstream <ws>
  changed since preview (rev <old> → <new>); preview again`) when an op,
  agent or worktree changed since; the revision hashes the newest op plus
  agent names/panes and worktree paths. `--yes` is removed (replaced by
  `--if`); `--empty` previews with one sweep revision and `--empty --if <n>`
  applies. `init` of a torn-down name previews (`will permanently delete
  torn-down <ws>: N tasks, M notes; rev=<n>`); `init --if <n>` deletes the
  old rows and creates the new workstream in one op group, and refuses while
  this machine still has agent rows in it. `list --torn-down` shows soft rows
  plus older teardowns found in the ops log (those stay final). A peer's
  `torn_down_at` applies by LWW and its later task puts still apply.
  `teardownWorkstream` now requires `ifRevision`; its result reports kept
  `tasks`/`notes`/`edges`/`keptWorktrees`. Teardown **never removes a
  worktree** (rows and directories stay; `mu agent close <agent>` applies the
  close rule). It asks the mux about every registered pane id, not only the
  session, and refuses (`WorkstreamPanesLiveError`, exit 4) while one outside
  `mu-<ws>` lives; `init --if` over a torn-down name probes the session first
  and refuses (`WorkstreamSessionLiveError`, exit 4) when it is alive or the
  probe fails. The commit re-reads the whole revision inside its transaction,
  and `--empty --if` applies each member's previewed revision (a member that
  changed mid-sweep is reported in `failed`). **One row rule:** an agent row
  is deleted only when its recorded pane is known dead, asked by pane id
  after the session kill and per row; a pane that is alive (moved during the
  kill) or cannot be asked keeps its row and socket (`orphanedAgents` in the
  result, a `KEPT` block in the output, an `orphaned-agents` row in
  `mu doctor`). `mu agent close` now sees agents of a torn-down workstream
  (a peer's teardown reaches machines whose panes live), kills the pane and
  deletes the row only once the pane is gone, else refuses with
  `AgentPaneStillAliveError` (exit 4, one line) and releases no worktree. The revision, torn-down, has-agents
  and live-pane refusals are one stderr line that names the command
  (`--json` keeps `nextSteps`).

- **Local-write guards in the DB** (`CAPTURE_VERSION` 2). Three persistent
  triggers, each `WHEN applying = 0`: claim CAS (`owner_id` cannot move from
  one agent to another), close needs evidence (a `kind = 'close'` note in the
  same op group, matched by exact note key), and close to `done` refuses open
  blockers. `mu task close` now **requires `--evidence`** for `done` (exit 2, one stderr line naming the command, also under
  `--if-ready` when it would close; before any write; a retry of an already-done close needs none); other
  substates need `--why`, which is their evidence, and may close over open
  blockers. `closeTask` writes its close notes (kind `close`) before the
  status update in one op group, so a close is one more op (the note).
  `CloseNeedsEvidenceError` and `TaskHasOpenBlockersError` (lists the open
  blockers; Next: `mu task tree`) exit 4. `--if-ready`'s skip no longer
  suggests "close anyway". Ingest, import and rebuild are never blocked;
  `mu doctor` warns (`closed-blockers`, `closed-evidence`, up to 10 ids each,
  in `--json` as `closeGuards`) about CLOSED tasks the guards would have
  refused; its repair is `mu task open` then `mu task close --evidence`
  (`mu task note` cannot write a close note). `mu sql` maps a guard's refusal
  to the same typed conflict (exit 4, `<id> -w <ws>` placeholders in Next).

- **Sync contract.** `mu sql` now ingests peer ops before the query and
  flushes its writes after, including when the statement throws (it was the
  one verb that opted out, so its writes sat unflushed until the next verb).
  Only `mu sync` keeps `ambientSync: false`. Every verb now refuses to run when
  the DB path is inside `MU_SYNC_DIR`: `DbInsideSyncDirError`, exit 4, thrown by
  `handle()` before `openDb` so nothing is created or written (the doctor
  `db-vs-sync` row stays).

- **Sync convergence and contract, round 2.** Apply is now a fold: live
  state for a key is defined as rebuild-of-that-key. `src/fold.ts` holds the
  only merge rules as pure per-key functions of the ops log (tombstone
  horizon, per-field LWW, substate, note sets, edges), `applyOp` re-folds
  the keys an op touches and `mu rebuild` folds every key, so live equals an
  HLC-order `rebuild` for every arrival order of one op set. This replaces
  the per-path comparisons (`applyPut`, `applyDel`, `applyEdgePut`,
  `repairTaskPair`, `applyContainerDel`) and the deferred-op repair
  (`reprojectDeferredOps`, the `user_version` marker, the pass-wide repair):
  an edge or note that arrives before its task lands when the task's put
  folds. Defaults that were "now" are log-derived: a task or workstream
  created by a partial put gets the wall clock of the HLC that began its
  life, so the same log folds to the same row on every machine (a restored
  workstream's `created_at` no longer depends on when it was applied). An
  edge re-added after a delete takes the re-add's `created_at`; a dead
  put's substate no longer survives a restore. `ApplyResult.skipped` is
  gone (callers only used `changed`); `RebuildReport.opsChangedRows` now
  counts table rows written. A 500-case randomized property test (fixed
  seed) asserts live == rebuild. An ambient flush that loses the segment
  lock prints `mu: sync: segment locked by another mu; this op publishes on
  the next flush` (exit stays 0) and `mu doctor` gains an `unpublished-ops`
  row. The DB-inside-`MU_SYNC_DIR` refusal resolves symlinks on both sides
  (a symlinked DB directory or sync dir no longer bypasses it) and `mu link`
  honours it.

- **Schema v12** (additive over v11; a v11 DB is refused with
  `SchemaTooOldError`, exit 4). New columns: `workstreams.torn_down_at`
  (synced), `agents.cwd` and `agents.base` (machine-local), `tasks.scored`
  (`NOT NULL DEFAULT 0`, `CHECK IN (0,1)`, synced), `tasks.dispatch_host`
  (synced), `task_notes.kind` (`NOT NULL DEFAULT 'note'`, `CHECK` one of
  `NOTE_KINDS`, synced). `tasks.impact` / `effort_days` stay `NOT NULL` and
  gain SQL defaults 50 / 1. New machine-local table `task_auto`
  (13 tables; 15 once persistent capture adds `op_ctx` and `op_dying`). New view `blockers(task_id, blocker_id, blocker_local_id,
  blocker_status)`; `ready`, `blocked`, `goals` and `blockers` skip torn-down
  workstreams, as do `resolveWorkstreamId`, `tryResolveWorkstreamId`,
  `listWorkstreams`, `TASK_FROM_JOIN` and the dormant sweep. Apply and ingest
  still see torn-down rows (`UNIQUE(name)`). The version stamp now commits
  inside the DDL transaction.

- **Persistent capture.** The capture triggers are stored in the DB file
  (were per-connection TEMP triggers), generated by the same
  `src/capture.ts` builders, so a plain write from any connection is captured
  (a safety net, not a supported path; plain `sqlite3` also defaults to
  `foreign_keys=0`). The op context moved from the TEMP tables `_op_ctx` /
  `_op_clock` / `_op_dying` to the main tables `op_ctx` (one row, seeded;
  also holds the HLC `now_ms` scratch) and `op_dying` (the delete-key stash,
  emptied by an AFTER DELETE trigger), both machine-local (15 tables).
  `withOpContext` and `withCaptureSuppressed` **own the transaction** when none
  is open (`BEGIN IMMEDIATE`, set ctx, run, reset ctx, `COMMIT`; a throw is
  `ROLLBACK`), so the context is never committed: a concurrent writer waits
  for the lock instead of being stamped with another scope's intent or
  `applying = 1`, and a crash cannot leave capture off. Nested calls inherit
  as before; `db.transaction()` inside becomes a savepoint. A second
  connection writing inside a scope now gets `SQLITE_BUSY`. Triggers carry a
  revision, `schema_version.capture_version` (`CAPTURE_VERSION`), separate
  from the schema number: newer is refused (`SchemaTooNewError`), older or
  missing is replaced in one `BEGIN IMMEDIATE` together with the stamp, equal
  runs no DDL and takes no lock. Emitting triggers abort below SQLite 3.42
  (`unixepoch('subsec')`); `openDb` throws `SqliteTooOldError` (exit 4).
  `mu doctor` gains a `capture` row (sqlite version, capture revision,
  sha256 of the stored triggers vs the generated DDL).

- **`mu sql` runs inside the scope's transaction.** `BEGIN`, `COMMIT`, `END`,
  `ROLLBACK`, `SAVEPOINT` and `RELEASE` are refused (`UsageError`: "mu sql
  runs inside mu's transaction; remove BEGIN/COMMIT"). `--confirm-rows` no
  longer opens its own transaction: a mismatch throws and the scope rolls
  back. A read-only statement skips the scope (no write lock). Transaction
  control is recognised by SQLite (the statement compiles to an `AutoCommit`
  or `Savepoint` opcode), one statement at a time, not by scanning for
  keywords, so identifiers named `begin`, `trigger` or `end` neither bypass
  nor trip the refusal. A nested scope restores the outer context only
  while the transaction is still open: an implicit rollback inside it
  (`INSERT OR ROLLBACK`, `RAISE(ROLLBACK)`) no longer autocommits it.

- **Explicit non-positive ids are refused.** An `INSERT` naming `id <= 0`
  (`rowid` on `task_edges`), including `-1`, raises `mu: explicit non-positive
  ids are refused` (local writes only; ingest is never refused). `-1` stays
  free to mean "omitted" in the BEFORE INSERT collision guard, so one raw
  `id = -1` row can no longer exist to confuse it.

- **New fields travel on v2 segment lines only.** `encodeSegmentLine` at v1
  refuses a payload carrying `scored`, `dispatch_host`, `kind` or
  `torn_down_at`. Apply drops a `scored` outside {0,1} and stores an unknown
  note `kind` (or none: a 3.x op) as `'note'`. A local `UPDATE` of
  `task_notes.kind` raises (`WHEN applying = 0`; ingest never raises).
  `mu doctor --deep` compares the new fields.

- **`ready` order and `mu task next`.** Scored tasks by impact/effort desc,
  then unscored tasks oldest first. `byRoiDesc` (the `roi` sort key, `next`,
  `my next`, `mu state`) and `listReady` share it. `mu task add -i/-e` are
  optional (defaults 50 / 1, unscored); giving either scores the task, and so
  does `mu task update --impact/--effort-days`, even at the current value.
  `TaskRow` gains `scored` and `dispatchHost`.

- **`MuxBackend` shrinks to the mux-seam contract.** The interface is
  `available`, `ensureSession`, `killSession`, `spawnAgent`, `listPanes`,
  `paneAlive`, `killPane`, `capture`, `attachCommands`, `healthCheck`,
  `paneNotFoundNextSteps` and the id validators, plus optional `paneStatus`
  and `sendToPane` (herdr) and the deprecated `currentSessionName` (scope
  fallback, goes with the `-w` unit). `spawnAgent(opts)` is one backend
  operation (tmux: create and run in one step; herdr: bare shell pane, then
  `agent start --kind` with the busy retry, refusing a command override
  before touching herdr and closing the bare pane when the start fails).
  `src/agents/spawn.ts` calls only `ensureSession` (scratch) and
  `spawnAgent`, and branches on the capability flag `spawnAgentWaitsReady`
  (herdr true, tmux false), not on a name. `spawnAgent` reports the pane
  through `onPaneCreated` as soon as it exists, so herdr's readiness wait
  (up to 30s) runs outside the per-session spawn lock.
  `listPanes(session)` replaces `listPanes` / `listPanesInSession`,
  `paneAlive` replaces `paneExists`, `capture` replaces `capturePane`;
  `MuxPane` has no `title`. `ensureSession` returns `{ created, repaired }`
  (`repaired`: the `_mu` window was re-added). `attachCommands` steps carry
  an optional `reason`; `attachShellLine(steps)` joins them with `&&`, an
  optional step as `{ step || true; }` (its failure never fails the line), and replaces `attachHint`. `mu workstream init` and the
  attach next step of `mu agent spawn` omit the line when `attachCommands`
  throws (herdr: no such workspace). Mux reads keep their failure modes:
  reconcile still propagates an unreachable mux instead of pruning every
  agent, and `workstream teardown` aborts on a failed liveness probe
  instead of deleting DB state while panes may live.

- **Worktrees replace workspaces.** `mu agent spawn <name> --worktree [--from
  <ref>] [--root <repo>]` runs `git -C <root> worktree add --detach
  <state dir>/worktrees/<workstream>/<name> [<ref>]`; the pane starts there
  and the worker's cwd *is* its worktree (briefs never `cd`). `--root`
  defaults to the git toplevel of the caller's cwd; `--cwd` conflicts with
  `--worktree`, `--from` / `--root` need it. `agents.cwd` records the pane's
  directory for every spawn (`--cwd`, default the caller's cwd) and
  `agents.base` the commit of a worktree; `mu agent list` shows a `cwd`
  column and `--json` carries `cwd` / `base`. **`mu agent close`** applies one
  rule to the worktree: dirty refuses before the pane is killed
  (`WorktreeDirtyError`, exit 4, up to 10 files listed; `--discard`
  overrides, lossy, no branch), clean and merged (nothing the base, the
  root's HEAD, `origin/HEAD` or `@{upstream}` lacks) is removed, clean with
  unmerged commits keeps `mu/<workstream>/<agent>-<sha12>` in the root repo,
  prints its name, and is removed. `workstream teardown` never removes a worktree
  (see above). New machine-local table **`worktrees`** (path,
  agent, workstream, root, base, last_collected_head), **not** keyed to
  `agents`: it outlives the agent, so a reaped agent's worktree is still
  closed by `mu agent close <name>` and a reused name can tell its own clean
  leftover (HEAD is the base or the last collected head, no branch made)
  from work it must not overwrite (`WorktreePathNotEmptyError`, one line).
  The reaper (`reconcile`) only deletes the agent row; it never touches a
  worktree or the registry. A failed spawn removes the worktree it made.
  `vcs_workspaces` is migrated and dropped: `openDb` treats a DB that still
  has it as not current, and `applySchema` copies every git row into
  `worktrees` (path, agent, workstream, base = `parent_ref`, `created_at`;
  `root` unknown, found from the worktree's own git pointer) and fills the
  agent's `cwd`/`base`, then drops it, all in its one transaction, so a dirty
  legacy workspace is still refused on close. `migrateLegacyWorkspaces(db,
  schema)` takes an ATTACHed source for the import.
  `spawn --worktree` bases on the caller's checkout: HEAD (or `--from`) is
  resolved in the git toplevel of `--root`/the caller's cwd, a linked checkout
  included; only the registry records the owning main checkout. The schema
  stays v12 (additive and idempotent, no bump). `EXPECTED_TABLES` is still 15
  (`worktrees` for `vcs_workspaces`).

- **Spawn injects exactly six identity variables**: `MU_MANAGED_AGENT`,
  `MU_AGENT_NAME`, `MU_WORKSTREAM`, `MU_CTL_SOCK`, `MU_DB_PATH` and
  `MU_STATE_DIR`, the last two absolute and **always** set (the default DB
  and state dir included), plus `SSH_AUTH_SOCK` forwarding as before. An
  in-memory DB pins the default DB path.

- The git layer is plain functions in `src/vcs/git.ts` (the one-implementation
  `VcsBackend` interface, `detectBackend` and `WorkspaceVcsRequiredError` are
  gone); `src/worktree.ts` holds creation, the registry and the close rule.
  `TeardownResult` reports `keptWorktrees` and `WorkstreamSummary`
  `worktreeCount`; `mu state` no longer prints a
  Workspaces section (`workspaces` is gone from its JSON); `mu doctor`'s
  `ws-rows` / `ws-empty` rows and `--disk` read the registry and
  `<state>/worktrees/`. The `mu task close` commit hint is `git -C <path> add
  -A && git -C <path> commit -m ...`; `mu task wait`'s inspect hint names the
  worktree and the same upstream-ref set.

- **Identity is `$MU_AGENT_NAME` only.** `resolveWorkerIdentity` no longer
  falls back to the pane title; nothing reads or writes pane titles, so a
  pane adopted without the env var resolves to `$USER` / `orchestrator`.

- **Segment lines are versioned per line; mu writes v2.**
  `SEGMENT_FORMAT_VERSION` is 2 and `SEGMENT_READ_VERSIONS` is `[1, 2]`: a
  segment may hold v1 history with v2 lines appended (same shape; the crc
  covers `v`), and the manifest stays valid over the mixed file. A line of
  any other version is an `unknown-version` defect that now carries the
  version found. Peer ingest stops there as before. An own segment holding
  any line of an unknown version is read-only to this build: flush
  appends nothing, repairs nothing, deletes its manifest, and reports
  `foreignVersionAt` / `foreignVersion` (also in `mu sync --json`); every
  flush, `mu sync` and `mu doctor` print "segment <path> has a v<N> line
  written by a newer mu; upgrade mu on this machine", and pending ops stay
  in SQLite until the upgrade. Repair of known-version damage keeps valid
  v1 lines byte for byte. `mu sync --from <db>` refuses a source DB whose
  `schema_version` is newer than this build (`SyncSourceTooNewError`, exit
  4). A 3.x reader stops at the first v2 line of each segment; rolling
  back means moving v2-holding segments out of `MU_SYNC_DIR` on every
  machine ([sync](../architecture/sync.md#segment-versions)).

### Removed

- **Dead-code sweep on the merged tree (`k_cut_leftovers`).** knip over `src/` and `extension/`
  found no unused file and no orphan beyond `terminalWidth`, `evidenceSuffix` and
  `isExecFailureLine`; all three are deleted. Doctor's human and `--json` collectors stay
  separate: a shared collector measured +7 code lines.

- **Legacy `nextSteps` hints are deleted, not wrapped; every result's `next` is computed once**
  (`v_hint_wire`, slice B of `v_hints`; README "Next contract"). `handle()` finalises `next` for
  success JSON (`emitJson`), failure JSON (`emitError`, `CliExitError` partial failures) and human
  text (one dim `next:` line, stderr on failure) from `computeNext` over the open DB after the verb's
  writes. A verb only declares what it did (`setNextOutcome`: a delivered send's exact wait, an
  unknown delivery's receipt check, a gate's wait, a `claim --for` brief, a preview's `--if <rev>`
  apply, a wait's stored resume); `resolveWorkstream` records the scope. Outside `handle()` (parse
  errors) `next` is null. The plan is cut to what the 4 KB result leaves (a `seq` dropped whole).
  Gone: `NextStep`, `HasNextSteps`, `hasNextSteps`, `printNextSteps(To)`, `formatNextSteps`, every
  `errorNextSteps()` and `inlineNext`, `paneNotFoundNextSteps`, `transportNextSteps`,
  `src/cli/dispatch-hints.ts`, the wait's `nextSteps`/`nextStepsCut`, the spawn orphan-cleanup hint
  and the triage `next=` trailer on `task list`. Reads, placeholders (`<id>`, `'...'`) and `a|b`
  are no longer printed as hints. Facts some hints carried survive as data or one-line prose:
  `agent spawn --json` and `workstream init --json` carry `attach` (the delegate tool reads it
  there), the dirty-worktree commit line on `task close` and the unseen-note send on `task note` are
  `warnings`, `mu rebuild` prints the swap command, a wrong task id prints `similar:` (human) beside
  `candidate_ids` (JSON), an ambiguous name adds `candidates`, and the prose-quoting and missing-CLI
  advice moved into the error message.
- **An unknown verb is one line, not the root help** (`df1_unknown_verb_dumps_help`, dogfood-1 F5).
  `mu next` used to print "too many arguments" plus 7.6 KB of help; it now prints
  `unknown command 'next' (closest: mu me next); see mu --help` (70 bytes for a word with no near
  verb). The closest verb is matched one level deep (`mu claim` → `mu task claim`); a namespace says
  `see mu task --help`. `--json` keeps `usage`.

- **The pre-engine wait code is deleted, not wrapped** (`v_wait_delete_old`). `src/tasks/wait.ts`
  (`waitForTasks`) and `src/agents/wait.ts` (`waitForAgents`) were adapters over `waitForEvents`;
  `mu agent wait` now calls `waitForEvents` directly (`src/cli/agents.ts`, with `ctlAgentHooks`) and
  `mu task wait` / `mu wait` already did. Gone from the SDK: `waitForTasks`, `waitForAgents`,
  `setWaitStuckWarnForTests`, `setAgentWaitSleepForTests`, `getWaitPollCount`, `resetWaitPollCount`,
  the `TaskWait*` / `AgentWait*` / `AgentStatusSnapshot` / `AgentWatch` types, `toStatusSnapshot`, the
  `inspect` wait option, and the never-thrown `ReaperDetectedDuringWaitError` and
  `StallDetectedDuringWaitError` (exit 6 and 7 are `WaitResult.exit`, never an error class).
  `setWaitSleepForTests` now lives in `src/wait.ts`. `mu agent wait` output and exit codes are unchanged.
  The tests that guarded the old adapters now guard the engine (`test/wait-events.test.ts`).

- **Leftovers (`k_cut_now`).** Segment lines are v2 only: the v1 reader, the encoder's
  v1 field guard and the keep-other-versions repair (`entriesOf`, `repairKeepingLines`,
  `opsBetween`) are gone, and a v1 line is refused like any unknown version. `openDb`
  accepts only schema 13 (v12 is `SchemaTooOldError`); the `vcs_workspaces` migration
  (`migrateLegacyWorkspaces`) and the missing-`capture_version` repair are gone. SDK/test-only
  exports removed: `capRecords`, `formatReadyTable`, `formatTaskListTable`, `boundedCommand`,
  `COMMAND_MAX_BYTES`, `showAllCommand`, `taskItem`, `taskRecord`, `tryResolveTaskId`,
  `tryResolveAgentId`, `ReaperDetectedDuringWaitError` (never thrown), `isUnscheduled`, `UNSCHEDULED_SUBSTATES`, `cmdMe`,
  `getActiveCommandForTest`, `clearActiveCommandForTest`.
  **SDK removal (no product caller):** the old doctor summary (`loadDoctorSummary`,
  `loadDoctorChecks`, `countProblems`, `yankCommandForCheck`, `remediationParagraph`,
  `DoctorSummary`), the old `WorkstreamSnapshot` loaders and helpers
  (`loadWorkstreamSnapshot[Fast|Slow]`, `mergeSnapshotFastSlow`, `roiBucket`,
  `agentStateHistogram`, `summarizeOwnedTasks`, and their types) and the old DAG
  renderers (`loadFullDag`, `renderForest`, `renderTaskTree`). `mu state` reads
  `stateSnapshot`, `mu doctor` runs its own checks, `mu task tree` reads
  `loadOpenTaskFrontier`.

- **`mu agent remote-env` and the `REMOTE:` / `REMOTE_BASE:` note convention.**
  A host profile's shell template carries the forward and the env now
  (`mu host init <host> --ssh` prints a starter). `mu state` reads remote
  workers from the registry, and `mu task claim --for` no longer prints the
  mule poll-and-close step (the task's close is yours, once the work is collected).

- **`mu link pi` and its shims.** pi now loads mu as a package: `package.json`
  declares `pi.extensions` (`./dist/extension/mu-pi.js`), `pi.skills`
  (`./skills`) and `pi.prompts` (`./prompts/*.md`), and lists
  `@earendil-works/pi-coding-agent` as an optional `*` peer (never bundled).
  Install with `pi install npm:@mu-crew/mu`. The extension no longer
  registers prompts through `resources_discover` (the manifest ships them),
  and `MU_EXTENSION_ENTRY` is gone.

- **`mu workspace` and the workspace flags.** The `mu workspace` namespace
  (`list`, `path`, `free`) is gone: `list` is `mu agent list` (cwd column),
  `path` is `mu agent list --json` `.cwd`, `free` is `mu agent close
  --discard`. `mu agent spawn --workspace`, `--workspace-from` and
  `--workspace-project-root` are replaced by `--worktree`, `--from`,
  `--root`; `mu agent close --discard-workspace` is `--discard`. Removed from
  the SDK and `src/index.ts`: `createWorkspace`, `freeWorkspace`,
  `getWorkspaceForAgent`, `listWorkspaces`, `workspacePath`,
  `Workspace{Exists,NotFound,PathNotEmpty,Preserved,OwnerBusy,VcsRequired}Error`,
  `HomeDirAsProjectRootError`, `VcsBackend`, `detectBackend`, `gitBackend`;
  the `workspace.create|free|refresh` log intents; `src/workspace.ts`,
  `src/workspace/`, `src/cli/workspace.ts`, `src/vcs.ts`,
  `src/vcs/{types,index,helpers}.ts`. `free --commit` (auto-commit before
  free) has no replacement: commit in the worktree, or close and keep the
  branch.

- **Pane titles, pane borders and mux session discovery.** Gone from the
  backends and the SDK: `setPaneTitle`, `lockPaneTitle`, `getPaneTitle`,
  `currentAgentName`, `currentPaneTitle`, `parseAgentNameFromTitle`,
  `composeAgentTitle`, `refreshAgentTitle` (and reconcile's title refresh),
  `enableMuPaneBorders*` and the `MU_BANNER_QUIET` env var, `listSessions`,
  `sessionExists`, `newSession`, `newSessionWithPane`, `listWindows`,
  `newWindow`, `selectLayout`, `splitWindow`, `startAgentInPane`,
  `ensureWorkstreamSession` (now `mux.ensureSession`) and the
  `title=` column of orphan panes in `mu agent list` / `mu state`.
  `mu workstream list` shows registered workstreams only: a `mu-*` session
  with no workstream row is no longer discovered, so `mu workstream teardown
  --empty` no longer prints its "Skipped N mu-* sessions" note
  (`listUnregisteredMuxWorkstreams` is gone). Teardown (soft, `--if <rev>`) acts on registered
  workstreams only.

- **The jj, sl and `cp -a` workspace backends, staleness, `workspace commits`
  and orphan listing.** `src/vcs/jj.ts`, `sl.ts`, `none.ts`, `src/staleness.ts`,
  `src/cli/staleness.ts`, `src/workspace/decorate.ts` and `orphans.ts` are gone
  (mu-next README Cut table: 582 git workspaces, 0 jj/sl). `mu workspace
  refresh|commits|orphans`, `mu agent spawn --workspace-backend`, and
  `--strict-staleness` on `mu task claim` and `mu agent send` are unknown.
  Refresh is a skill sentence: `git -C <cwd> fetch && git
  -C <cwd> rebase <base>`. Also gone: the `behind` column, the stale-workspace
  and orphan sections of `mu state` (and `workspaceOrphans`, `recentCommits`,
  `commitsBackend` from its `--json`), the `workspaces` doctor-summary row,
  the `ws-dirs` doctor row, `TaskClaimStaleWorkspaceError`,
  `WorkspaceDirtyError`, `WorkspaceConflictError`, `staleness` in `mu task
  claim` and `mu agent send --json`, and the SDK's `refreshWorkspace`,
  `listCommitsForWorkspace`, `decorateWith*`, `*Orphan*` and `jjBackend`,
  `slBackend`, `noneBackend`. `mu task wait`'s hint after a worker closes
  is now `git -C <path> log --oneline HEAD --not <refs>`. `<refs>` is
  everything already upstream: `parent_ref`, the project root's HEAD,
  `origin/HEAD` when it resolves, and the root's `@{upstream}` when set. `mu
  agent close` uses the same set for its own-commits check, so a manual `git
  rebase` onto advanced local main, or `git fetch && git rebase origin/HEAD`,
  neither blocks closing an empty clean worker nor lists the base's commits.

- **`mu undo`.** Teardown is soft (see Changed). `mu log --group
  <prefix>` still resolves a group prefix; an unknown one now raises
  `GroupNotFoundError` (exit 3). The SDK drops `undoGroup`, `planUndo`,
  `listRecentGroups`, `mostRecentGroup`, `resolveGroupId` and
  `priorFieldValue`.

- The card TUI (bare `mu`, `mu state --tui`). Bare `mu` prints help until
  the mu-next dashboard lands. Also gone: the `MU_NO_TUI` and
  `MU_TUI_DEBUG_MOUSE` env vars, the `ink`, `react` and `react-devtools-core`
  dependencies, the `dist/tui-sync-worker.js` bundle and
  `src/project-root.ts` (its only caller was the TUI launch ladder).

- **The refute nudge.** `registerRefuteNudge`, `refuteNudgeText`,
  `dispatchedTasks` and the `mu-refute-brief` message are gone; unrefuted
  dispatches no longer get a notice. The keep-driving and close nudges stay,
  and `MU_NUDGE=0` now turns off those two. `parallelSettle` merges two
  handlers, not three.

- **Legacy op handling.** `src/legacy-ops.ts` is gone. Old `workstream.export`
  prose ops are no longer skipped by apply, rebuild, flush, ingest and
  `--from`; they are treated like any other op (none exist in the live DB or
  sync dir). The `workstream.destroy` spelling is no longer a synonym of
  `workstream.teardown`: `mu log --intent workstream.teardown`, `mu workstream
  list --torn-down` and `mu workstream forget` match only the new name, and a
  `workstream.destroy` op renders as an unknown intent (6 such lines in peer
  segments, accepted).

- **The v7-v10 migration sidecar.** `scripts/migrate.ts`,
  `scripts/migrate-recovery.ts`, `scripts/README.md` and
  `test/migrate.integration.test.ts` are gone (mu-next README Cut table;
  the cut-over import replaces them). A too-old DB is refused with
  `SchemaTooOldError`; its next steps are now a `sqlite3 .backup` copy
  (mu cannot open the DB, so `mu db backup` was unreachable) and moving
  the file aside. `docs/guide/upgrade.md` drops the migration recipe.

- **`mu agent kick`, `mu agent adopt` and the tmux paste send.** `mu agent
  send --via`, `src/agents/kick.ts`, `src/agents/adopt.ts`,
  `src/mux/input-timing.ts`, `MU_SEND_DELAY_MS`, `MU_SEND_READINESS_MS`,
  `MuxBackend.paneTTY` and `PaneNotInSessionError` are gone (mu-next README
  Cut table: 0, 2, 2 real uses). `MuxBackend.sendToPane` is now optional and
  herdr-only (its atomic `agent prompt`). A send to a non-pi agent on tmux
  throws the new `AgentSendUnsupportedError` (exit 4) instead of pasting.
  `mu agent abort` and `send --interrupt` hints now point at `mu agent
  close`; an outdated extension that lacks op `command` is reloaded or respawned as described under `mu agent send`; `ClaimerNotRegisteredError` drops its adopt step; the
  doctor `ctl` row's `reloadVia` is `"ctl"` or `"respawn"`. Old
  `agent.adopt` / `agent.kick` log rows still render.

- **The decorative delegate footer and failed-delegate pruning.** pi's footer
  status (`delegates running/queued`, `N results pending`, failed count),
  its key and formatter, and the `PRUNE_FAILED_MS` failed-pruning are gone
  (`delegateStatus`, `DELEGATE_STATUS_KEY`, `PRUNE_FAILED_MS`). Unchanged:
  admission control (`MU_DELEGATE_MAX` running plus a bounded queue, refusal
  past it), arriving-answer delivery safety (Escape copies, the one resend,
  the "already handled" stub), and `murmur:pending` `{source,count}`.
  `docs/guide/delegate.md` still describes the footer; its pruning is
  tracked for the docs consolidation.

### Fixed

- **`mu state` with no multiplexer prints the one human line on stderr** (`matrix_followups`). It is JSON
  without `--json`, so its `NoMultiplexerError` refusal went out as a failure document on stdout and
  nothing on stderr; it now prints `no multiplexer: … install tmux …` like every other verb (`state --json`
  keeps the document). `mu task wait --help` names `mu wait task:<id> agent:<name>` for mixed refs.
  Eval: the `worker_dies` holdout judge (and `tasksRunTwice`) accept a worker's `block` record as its
  finish, as the other judges do; only the action parsing changed.

- **A remote command gate no longer lists as `unknown: murmur has no row`.** `mu agent list`,
  `mu agent show` and `mu state` read a gate from its pane (running reads `busy`, an ended one
  `unknown` with `exited <n>`), never through a host exec. `readGate` drops its pre-read channel
  release: the result read's admission already reclaims a dead pane's channel.

- **A worker that dies between two waits is `dead` (exit 6), not a heartbeat**
  (`df2_wait_dead_after_reap`, dogfood-2 F1). A wait used to see a reaper flip only if one of its own
  ticks had seen the owner first (in memory), so a wait started after the death, or a `mu wait
  --resume` run after it, got a heartbeat with the task OPEN. The flip is now read from the ops log:
  a watched task whose latest status change is the reaper's (`task.reap`) is dead when the flip came
  after the wait's anchor. The anchor is the ops head when the wait starts; `--resume` replays the
  stored one (`wait_resumes.spec.since`); a ref a caller registered owes every flip until its cursor
  consumes it. A later claim, release, park or close is a decision and is not reported dead.
- **A dead agent ref no longer hints `mu task show <agent name>`** (`df2_dead_hint_agent_ref`,
  dogfood-2 F2). The hint now names the reaper's log lines, `mu log -w <ws> --source reaper -n 10`,
  which list the tasks it reopened.
- **A spawn killed during worktree creation rolls back** (`bug_spawn_worktree_abort_cleanup`).
  `mu agent spawn` now handles SIGINT/SIGTERM (exit 130/143, a `SpawnInterruptedError` document
  under `--json`): `git worktree add` runs in its own process group and is killed with its hooks,
  the half-made worktree is removed (`git worktree remove --force --force`, it is locked
  `initializing`), and the placeholder and registry rows are dropped, as for a thrown error. Before,
  the placeholder row, a registered worktree and a live git child were left behind, and the name
  refused (`AgentExistsError`). A SIGKILL leftover (a **dead staging**) is listed by `mu doctor`
  (`ws-staging`) and removed by the next spawn in its workstream. The pi extension's runner, on
  abort, SIGTERMs mu and returns only once it exited (SIGKILL after 10 s), so `mu_delegate` no
  longer reports a cancelled spawn while it is still rolling back.

- **`mu_delegate` with `workspace: true` honours `cwd` as the repo** (`bug_delegate_workspace_root`).
  It spawns `--worktree --root <cwd>`, so a pi session in a parent of several repos can name the one
  to branch; without `cwd` the caller's directory stays the repo. A queued or reissued call replays
  the root from the stored request. A spawn refusal that cannot change on retry
  (`WorktreeVcsRequiredError`, `UsageError`) is recorded as failed with the CLI's message and the fix
  (`Pass cwd: <a git repo>`), no longer as a refused call to reissue.

- **Tests no longer write to the real `~/.cache/mu` or `~/.local/state/mu(-next)`.**
  `test/_setup.ts` points `XDG_CACHE_HOME`, `XDG_STATE_HOME` and `XDG_CONFIG_HOME` at a per-fork temp dir
  (removed on exit), and `test/_real-dir-guard.ts` throws on any `fs` write under the real dirs, like the
  real-DB guard in `openDb`. Fixture delegate answers had been landing in `~/.cache/mu/delegate-answers`.
- **A finished worker is not `dead`: an agent ref is owed only while it owns open work or an
  unsettled run** (`df1_wait_stale_dead`, dogfood-1 F1; round 2 of `v_wait_arming`). With arming, the
  orchestrator's `claim --for` + `send` left the worker's agent ref registered after its task closed;
  a deliberate `mu agent close` then made the next wait (bare, explicit task, or `send --wait`) exit 6
  `dead`, "the work is not done". One rule now lives in `src/wait-owed.ts`: an agent ref is DONE when
  every task the agent owned is CLOSED (or released), nothing it was sent is unsettled and it is idle.
  Every wait tick keeps a DONE mark per owned agent (a `wait_cursors` row `done|agent:<ws>/<name>`,
  machine-local) true to what it read, and `agent close` sets it when the agent holds no open task
  and no run in flight. A registered agent whose row is gone and which carries the mark is dropped
  from the registration with no event. `dead` is left for a pane lost while work or a run is owed
  (a task still open, a run busy or unsettled, or never read at all). New work armed for the agent
  clears the mark. The `dead` reason for an agent ref no longer says "the work is not done" ("gone
  (its pane died or it was closed)"); a task whose owner died keeps it.

- **Explicit ids above 2^53-1 are refused (`CAPTURE_VERSION` 4).** An `INSERT`
  naming `id = 9223372036854775807` moved the AUTOINCREMENT counter to the max and
  bricked every later insert ("database or disk is full") with no `mu` repair, now
  that `sqlite_sequence` is protected. Local writes refuse it
  (`mu: explicit ids above 2^53-1 are refused`, one usage line from `mu db query`);
  ingest is unaffected. A `mu db query` whose retrieval command would exceed 1 KB
  now says "re-run the same query with --all" instead of echoing the query.

- **`mu db query` no longer writes `sqlite_sequence`, `sync_peers` or row ids.**
  One `UPDATE sqlite_sequence` could brick every later captured write ("database or
  disk is full"); a forged `sync_peers` watermark skipped peer ops until a repair; an
  `UPDATE tasks SET id=-1` slipped past the INSERT-only id guard. All three are
  refused (the `sync_peers` refusal names `mu sync --repair <peer>`);
  AUTOINCREMENT inserts still work.

- **`mu db query` no longer writes `machine_identity`.** Its HLC clock and machine id
  feed every captured op, so a forged id or clock silently unpublished later ops.
  Only a main `_cap_*` trigger writes it now.

- **Remote spawn follow-ups.** A rollback whose pane survives the kill keeps a
  host agent's row (and so its channel) and says so in the log, instead of
  freeing the slot under a live pane. The transport pane runs with the local
  `MU_DB_PATH`, `MU_STATE_DIR`, `MU_SYNC_DIR`, `MU_CTL_SOCK`, `MU_AGENT_NAME`,
  `MU_WORKSTREAM` and `MU_MANAGED_AGENT` unset (a tmux pane inherits the
  server's, possibly another agent's). `agent close` suggests the re-spawn with
  `--host`, `agent show` prints the host, and stale `remote-env` mentions are gone.

- **The attach hint works from outside tmux.** Outside a client it is ONE
  `tmux attach-session -t mu-<ws>:<agent>` (the old line ran `select-window`
  only after the blocking attach detached), and every tmux attach/switch line
  carries `-L <socket>` when `MU_TMUX_SOCKET` routes mu to a private server.
  herdr is unchanged.
- **A delegate answer lost to the dequeue key is sent again, once.** pi's dequeue
  key (alt+up) calls `session.clearQueue()`, which silently drops custom
  follow-ups; the run then ends with `aborted: false`, so the Escape path saw
  nothing and the answer never arrived. Each answer has a delivery id from
  `sendMessage` to its `message_start`. After a normal settle, one tick later,
  and only if pi is idle and no answer was accepted since, the extension resends
  ONE unstarted answer (the next settle finds the next). Escape never resends:
  it drops what is pending with copies and one note, and defuses those answers'
  sends that pi deferred while settling (no turn; a stub if they start). A
  second start of an id (pi can still do that) is rewritten in place to a
  one-line "already handled" stub, so a repeat costs the model no answer text.
  `MU_DELEGATE_TRACE=1` logs every follow-up send and pi lifecycle event to
  `<cache dir>/delegate-trace.log`. Tested against pi's real `AgentSession`
  (`test/extension-delegate-pi.integration.test.ts`).

- **`mu_delegate` `record` kept an empty `EVIDENCE:` header.** `recordNote` kept
  only lines that start with `EVIDENCE:`, so a refuter's multi-line evidence
  body was dropped. It now keeps everything from the last `VERDICT:` line on
  (still capped at 4000 chars).

- **Test runs no longer leak `/tmp/<id>/ssr`.** vitest 5 never removes the root
  Vitest instance's tmp dir (`<tmpdir>/<nanoid>`, 6-17 MB of transformed
  modules per run), which filled a tmpfs `/tmp`. `test/_global-teardown.ts`
  (shared by both vitest configs) now removes it in teardown.
  `test/dag.integration.test.ts` also removes its `mu-dag-*` temp dirs.

- **ultrathink closes on no *unfixed* high finding.** A final refuter pass
  that finds highs which are then fixed now satisfies the stop rule.

- **`touchTask` is monotonic.** A note or edge write whose clock read earlier
  than the stored `updated_at` no longer moves it backwards.

- **`mu sql` `INSERT OR REPLACE` can no longer re-key a row without a
  tombstone.** A BEFORE INSERT guard on `workstreams`, `tasks`,
  `task_notes` and `task_edges` refuses an insert whose id or natural key
  already exists. `ensureWorkstream` and `addBlockEdge` now insert with
  `WHERE NOT EXISTS`, since the guard also aborts `INSERT OR IGNORE`. The
  `task_edges` guard also refuses a colliding hidden rowid. The id check
  ignores SQLite's `-1` placeholder for an omitted id, so a raw `id = -1`
  row no longer blocks every later insert.
