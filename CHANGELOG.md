# Changelog

All notable changes to mu are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/). mu follows
[Semantic Versioning](https://semver.org/) from 1.0.0 onward.

Older releases: [docs/history/CHANGELOG-pre-3.md](docs/history/CHANGELOG-pre-3.md).

---


## [Unreleased]

**mu 4.0: a rewrite for agent callers.** Every verb, result and error is shaped
for a model to read and act on, and only the dashboard is for a human. The
database, the ops log and the task DAG carry over in spirit, but 4.0 is a
breaking release with its own DB. The full change-by-change record of the 4.0
development is [docs/history/CHANGELOG-4.0-dev.md](docs/history/CHANGELOG-4.0-dev.md).
- **Finishing a wait no longer erases a newer send armed for the same agent** (`rr_r2_rearm_lost`, pre-release review R2, P2 per the refuter). A registration kept the EARLIEST fence of one pi process, so a send armed at run 1 (from `onPicture`, or a concurrent `mu agent send`) changed nothing, and `endWait` then dropped the ref by key when the wait delivered run 1: run 2 was never watched. The baseline now also keeps the LATEST fence (`latest`, only when later than `afterRuns`). `endWait` takes the delivered run (`runs`, `incarnation`) and drops an agent ref only when that run is past `latest`; otherwise the ref stays, counted from the delivered run. A probed fence never raises `latest`. Tests: `test/wait-rearm-race.test.ts` (engine interleaving, `endWait` both sides), mutation-checked (ignoring `latest`; not keeping the ref).
- **A resume keeps an unfinished agent run and the targets an early return did not consume** (`rr_r2_resume_drops_work`, pre-release review R2, P2 per the refuter). `mu wait agent:w/a --first` that ended on the agent's dialog printed no resume (the event's ref was taken as delivered), and `--all` ended early by a dialog dropped a closed task from the resume. `WaitResult.delivered` now lists the refs the engine handed over as COMPLETED (closed, settled, delegate, ...; the same set the commit consumes), and `owedRefs` drops exactly those: never an input or stall, never a target the returning event did not name. `owedRefs` lost its `mode` argument. Test: `test/wait-owed-refs.test.ts` (real engine into `owedRefs`, both modes), mutation-checked (counting every fired ref; counting input/stall).
- **A refused delegate call no longer holds the settle in a heartbeat loop** (`rr_r2_refused_settle_loop`, pre-release review R2, P1). The owned wait listed every call of the callers as owed, and a refused call (admission past `MU_DELEGATE_MAX`, an unsent spawn, a `/reload` parking queued calls) is never terminal, so a bare `mu wait` heartbeated on it for ever and pi never ended its turn. A refused call is now neither owed nor a wave target (the wave tally still counts it; its answer is not marked consumed), and `mu wait delegate:<refused>` is refused at once (`WaitRefError`) with the reissue hint. Test: `test/wait-refused-call.test.ts`, mutation-checked (owing it again, accepting the ref).
### Changed

Upgrade: [docs/guide/upgrade.md](docs/guide/upgrade.md). Then run `mu doctor`
and send `/reload` to running pi agents.
- **CLI surface fixes, one per finding** (`rr_fix_r4_surface`). `mu delegates show <unknown>` is exit 3 `DelegateNotFoundError` (it was a `UsageError`, exit 2) like every other not-found (`rr_r4_delegates_show_exit2`). `mu task claim` with no claimer (no `--for`, `--self` or `$MU_AGENT_NAME`) is a one-line usage error, exit 2: `no claimer: pass --for <worker> (dispatch), --self (orchestrator), or run in a mu-spawned pane`; it was exit 1 naming the SDK's `opts.agentName`. `claimTask:` is gone from the `--self`/`--for` message (`rr_r4_claim_no_agent_plain_error`). **A close with no reason is one lane, exit 2** (`rr_r4_close_reason_exit_split`): `mu task close` without `--evidence`, `--as <x>` without `--why`, and a `mu sql --write` close with no close note were three paths with two exit codes (2 and 4) and two error classes. All now raise the typed `CloseNeedsEvidenceError` / `SubstateReasonRequiredError` and exit 2 (a missing flag is usage), one line, no help dump. The SDK message now carries the command: `closing b1 needs evidence: mu task close b1 -w ws --evidence "<command + result>"`. A script that branched on exit 4 for these must branch on 2. Tests: `test/cli-close-reason-lane.test.ts`. **A `--json` failure's `message` is one line** (`rr_r4_json_message_multiline`): commander's `\n(Did you mean --status?)` is folded in, `unknown option '--stauts' (Did you mean --status?)`, as `src/output-contract.ts` promises. Test: `test/cli-json-wire-matrix.test.ts`. **`--report` help tells the truth** (`rr_r4_report_set_once`): it said "set once", but a second `--report` is accepted and the default view shows the last. `task note` and `task close` now say "the last report wins, earlier ones stay in `mu task notes <id> --all`" (reworded, not refused: a retry after a dead worker files a new report by design). **`task next` loses `--status` and `--substate`** (`rr_r4_next_status_filter_noop`): it reads the `ready` view (OPEN, not parked or triage, no open blocker), so the filters could only narrow it to nothing (`--status CLOSED` printed `(no ready tasks)`) while the help listed values that never match. `mu task list --status/--substate` is the filter. `listReady` and the `ListReadyOptions` export lose the options too; `test/cli-task-next-multi-status.integration.test.ts` is replaced by `test/cli-task-next-no-filters.test.ts`. **`task add --json` uses the SQL-column shape** (`rr_r4_task_add_json_camel`): `data.task` and `data.tasks[]` were the SDK row (`name`, `workstreamName`, `effortDays`, `ownerName`, `createdAt`, `scored: false`, `roi`) while every read verb printed `id`, `effort_days`, `workstream_id`, `scored: 0|1`; a script reading `.data.task.id` after an add got `null`. Both now go through `taskToOutput`, the record `task show` prints (no `roi`, which no read verb has either). Consumers checked: skills, recipes, `tools/eval` and the extension read no field of the add result. Test: `test/cli-task-add-json-shape.test.ts`; the truncation test reads `.task.id`. **A usage error that names its fix is one line** (`rr_r4_usage_help_dump_fix_named`): `db backup` onto an existing file, `db forget` of a live workstream, `task note` with no text, `task update` with nothing, an empty-slug title (now ends `pass one: mu task add <id> -t "..."`), an invalid workstream name, and an unknown option on the bare root (`unknown option '--foo'; see mu --help`) no longer dump the verb's help (8 to 70 lines) after the line that already names the fix. `mu db backup` onto an existing file is exit 4 (`BackupTargetExistsError`) like `mu rebuild`'s collision, it was 2. The invalid-name line is `invalid workstream name "X": use [a-z][a-z0-9_-]{0,31}`; the tmux rationale moved to `docs/reference/naming.md`. A usage error that names no fix still prints the verb's help. Tests: `test/cli-usage-one-line.test.ts`. **P3 batch** (`rr_r4_p3_batch`): `mu task ls` and `mu task rm` name `list` and `delete` in the did-you-mean; `task list --help` describes the records it prints (id, status, impact, effort, scored; it said "ROI, owner"); `docs/guide/sql.md` lists exit 1; two garbled or false comments reworded and the `messages.ts` header says "most" lines. The rest (bare `mu task --json`, test-only exports, ~70 inline error literals) is one ROADMAP row.

- **One workstream rule: an unknown `-w` is exit 3 on every verb** (`rr_fix_r4_ws`; findings `rr_r4_unknown_ws_reads_silent`, `rr_r4_ws_mismatch_before_resolve`). `task list`, `task next`, `agent list` and `log` answered a typo'd `-w` with an empty success ("nothing to do"), and `task add -w nows` created the workstream `nows`. Every verb that acts inside a workstream now checks it exists (`resolveExistingWorkstream` in `src/cli.ts`, the same check `state` uses): `no such workstream: r4w (did you mean r4ws?); \`mu workstream init r4w\` creates it`, exit 3. The `init` fix is left out when the name could not be a workstream. The reserved `scratch` still auto-creates on its first `task add`, and `agent spawn` still creates its workstream (a spawn is the create path; `-w` there is the name you are choosing). `mu log` still reads a destroyed workstream's history. A task or agent verb with a wrong `-w` now validates and checks the name first (an invalid or unknown name is exit 2 or 3, no longer a scope conflict), and the exit-4 conflict ends with the fix: `task a1 is in workstream r4ws, not other; pass -w r4ws`. `editDistance` moved to the leaf `src/edit-distance.ts`. Tests: `test/cli-unknown-workstream.test.ts`, red first.

### Breaking
- **Dashboard: the snapshot is the shown workstream's, so the Overview survives the Tasks filter, a tick is cheap, a torn-down workstream recovers, sync problems stay** (`rr_fix_r5_scope`, pre-release review R5: `rr_r5_overview_follows_tasks_filter` P1, `rr_r5_idle_cpu_all_ws_reads`, `rr_r5_torn_down_ws_stale_chosen`, `rr_r5_sync_warnings_flash` P2, and the P3s `rr_r5_dead_exports`, `rr_r5_dup_helpers`, `rr_r5_ws_row_cuts_selected`, `rr_r5_p3_batch`).
  - **P1:** the Tasks status filter was part of the one snapshot query, so on `closed` the Overview cards read "nothing open" and a human attention item lost its Enter drill. The query no longer carries it: the status filter is applied client-side like the text filter, and CLOSED tasks are loaded only while the Tasks tab asks for them. Red test in `test/dashboard-overview.test.ts`.
  - **Idle CPU:** every tick read the tasks and frontier of every live workstream (115 ms at 20 workstreams x 150 tasks) though one is shown. New `DashboardOptions.scopeWorkstream` reads tasks, edges and frontier of that workstream only; agents, log, caller panels and attention stay machine-wide. The IN_PROGRESS-owner and OPEN-human passes are one SQL query each. The app queries with the shown workstream from the first read. Numbers in the task close note.
  - **Torn-down workstream:** the row fell back to another workstream but the query kept the dead one, so the Log stayed at 0 rows. The query and the state now follow the resolved workstream.
  - **Sync warnings:** the runtime keeps the latest ingest's warnings and passes them to every read, so the `sync` attention item (and the strip) lasts until an ingest comes back clean, instead of one tick. The footer special case is gone (the strip says it).
  - **Cleanups:** the workstream row's scroll counts the `…` prefix and visual width; one duration format (`1m05s`, `3h00m`) for the strip and the tool column (the strip's was `20m`); `formatPair`, `matches` and a `scrollbackOf` helper replace three status renderings, two matchers and two scrollback literals; the test-only `workstreamLine`, `renderRow`, `frameLines`/`frameParts`, `columnWidths`' total branch, `borderLine` and `Row.notice` are deleted (the frame tests draw `<Frame>`), the in-file-only exports are private, and stale comments are fixed.
- **Dashboard: fully live, the 3.x way** (`tui_live_updates`, user request). Lists polled every 2 s and probed every agent's control socket on each poll. Drills loaded once and changed only on `r`. The 3.x mechanism (v3.13.3 `state.ts`, `task-detail.tsx`) is ported, and every view is live:
  - **One poll loop** (`use-snapshot.ts`), kept running while a drill is open. The fast tick (default 1 s, `+`/`-` live from 100 ms to 10 s) is SQL only: agent states come from the runtime's cache. The slow tick (10 s, `SLOW_TICK_MS`) re-probes every agent into that cache. `r` and a tab switch run it now. A new agent is probed once on the fast tick.
  - **Flicker guard:** a snapshot whose key matches the published one sets no state and renders nothing. The key is the visible content, with tool clocks counted in whole seconds. `nonce` moves only when the key changes.
  - **Drills:** notes re-read on `nonce`, with a live `status @owner title` line pinned under the title. Scrollback re-captures on the slow tick. A log entry shows its task's current line. A refresh keeps the previous body (no `loading…` flash) and the scroll position of the same entity. A body scrolled to its end follows new lines.
  - **Cursor:** it stays on its row's key when rows reorder. A row that leaves (closed, deleted) hands the cursor to its neighbour, not the top.
  - **React production build:** the dashboard sets `NODE_ENV=production` when it is unset. The development build was ~2x the idle CPU (profiled).

- **`mu agent wait` times out with exit 0, like `mu wait`** (`rr_r7_wait_exit5_timeout`, `rr_fix_r7_comments`). One timeout rule for every wait: a timeout is not an error. `mu agent wait` exited 5 on timeout while `mu wait` and `mu task wait` exit 0 with `ok:true, timedOut`; it now exits 0 too (the document already said `timedOut`, and each agent's `afterRuns` keeps a re-run lossless). Exit 6 (pane died) and 7 (dialog) are unchanged. Scripts that branched on `agent wait` exit 5 read `timedOut` instead. Also fixed: comments and `task claim --help` named the dropped `agent_logs` table (the `--self` actor is in `ops.actor`), the `logs.ts`, `db.ts`, `tmux.ts` and `workstream.ts` headers described a shim, a v12 schema and a `mu init` verb that are gone, and comments pointed at removed symbols.

  Measured with the new `smoke.py live` (s2 driven by the CLI from a second process), latency counted from the write's return to the screen: Overview strip appears 0.47 s and clears 0.78 s; Next line 0.00 s; Tasks row add 0.42 s, close 0.89 s; DAG edge 0.11 s; Log row 0.36 s; note in an open notes drill 0.42 s; scrollback 8.4 s and agent death 9.4 s (slow tier, 10 s budget). Idle CPU on Tasks over 60 s: 1.67% of one core. Overview with two ticking tool clocks: 2.23%. s6 under the mutator: 2.13%, and an open notes drill grows with no key press. Tests: `test/dashboard-live.test.ts`.

- **Dashboard: the 3.x colour palette** (`tui_u8_colors`, user request). The dashboard was monochrome apart from a yellow strip. It now uses the 3.x TUI's colours (v3.13.3: titled-box, list-row, `inkColorForPair`, `STATUS_COLORS`, the log card, the tab strip, the drill): gray rounded frames with a bold cyan title, a dim count and a dim `+N more`; task status OPEN cyan, OPEN/parked and OPEN/triage gray, IN_PROGRESS yellow, CLOSED/done green, any other CLOSED red; ids bold, owners, hosts and times dim; agent state busy cyan, needs_permission magenta, idle and unknown dim, a dead agent red, a stalled tool yellow; the log verb cyan (operator prose stays plain); the selected workstream and tab bold cyan, the rest dim; a drill's title bold magenta; the strip's `✓ all quiet` green, its items yellow, dead ones red. The cursor row stays solid inverse with per-cell colour dropped, as 3.x's CursorRow did. Every colour is a named role in one new module, `src/cli/tui/theme.ts`, and no view names a colour. Rows now carry a styled `line` next to their plain `text`, and the text is derived from the line, so the two cannot differ. **NO_COLOR** (any value) turns every colour off and keeps bold, dim and inverse. Ink's chalk 6 does not read NO_COLOR (measured: level 3 under a PTY with `NO_COLOR=1`), so the theme checks it. **No state glyphs:** 3.x drew Nerd Font codepoints with no ASCII fallback (`src/glyphs.ts`: "Requires a Nerd Font"), so the ASCII markers stay. Tests: `test/tui-theme.test.ts` (roles, styled rows, strip, `fitLine`, SGR codes through ink with colour on and under NO_COLOR). PTY captures (`capture-pane -e`) for s2 and s4 at 200x50 and an s4 NO_COLOR capture with zero colour codes; `smoke.py` passes.

- **Dashboard: Ctrl-d/Ctrl-u and g/gg/G everywhere, hint pinned on every screen, Enter in DAG** (`tui_u9_keys_pin`, dogfood feedback 2). Every list (the tabs, the Overview's Attention cursor) and every drill body (notes, scrollback, log entry) now moves through one key map, the new `src/cli/tui/nav.ts`: j/k, Ctrl-d/Ctrl-u half a page, PgUp/PgDn, `g` (so `gg` too) top, `G` bottom. The hints read `j/k ^d/^u g/G`. A drill was as tall as its body, so opening a task with short notes pulled the hint up near the top. Every drill is now exactly the terminal's rows, with the hint on the last row. DAG rows had no drill target, so Enter did nothing; it now opens that task's notes, the same drill as Tasks. Tests: `test/dashboard-drill.test.ts` (drill pinned at 120x40 and 80x24 for notes, scrollback and log; DAG Enter; drill and list keys), red before the fix. `smoke.py drill` checks the same on s2 through real tmux. **The attention strip is on every view** (user follow-up). The Overview used to drop it, because its Attention card stood in for it, and drills had none. Now the one line (`⚠ 4 need you: …` or `✓ all quiet`) sits under the tabs on the Overview and on every tab, and under the title in every drill. The Attention card stays, since it holds the cursor. Tests: `test/dashboard-overview.test.ts`, red first. `smoke.py fill` requires the strip on row 3 of every screen (`⚠` in s4), and `smoke.py drill` requires it on row 2.

- **TUI dogfood kit, second pass** (`tui_u7_kit`, dogfood item 7; [PLAN](docs/mu-next/tui-dogfood/PLAN.md) U7). This is kit only, with no `src/` change. The scenario 7 workers now look different: each pane starts with a banner and prefixes every line with `remote:dev` or `local` (`fake-worker.mjs --banner`), and `worker-2` waits for input instead of running the same busy profile as `worker-1`. `FORM.md` is rewritten for the second human pass, with one section per original feedback item (viewport, sort and detach, trouble first, workstream switch, column stability, remote/local) that asks whether it is fixed, whether it is better, and what still bugs you. The README documents the Overview tab, `s` sort, `o` status and the detach hint. `smoke.py` adds `fill` (s2/s4/s5/s7 at 200x50, 120x40 and 80x24, every tab, read off a private tmux screen: the last row is the hint, every tab frame reaches the last body row, and an Overview column with `+N more` does too) and `stable` (s6 Tasks and Log: the second column starts at the same x in two screens 5 s apart). All of it passes. At 200x50 the Overview's blank rows sit only under columns with nothing hidden (s2 and s4: Attention and Agents fit; s5: Open and Log fill to the footer), so `grid.ts` is unchanged.

- **Dashboard: Overview first screen, framed full-height tabs, attention strip, pinned footer** (`tui_u6_screen`, dogfood items 1 and 4; [PLAN](docs/mu-next/tui-dogfood/PLAN.md) U6). The screen used 13 of 50 rows. Bare `mu` now opens on **Overview**: framed cards for the workstream (Attention over every workstream, Agents, In progress, Open by ROI, Log tail) in 1/2/3 columns at <120/120/180 cols, rows shared by `grid.ts` so a card hiding data grows and says `+N more`; j/k and Enter work on the attention items (agent scrollback or task notes). The other tabs are one frame each (tab name and count in the top border, `12/197` in the bottom) that fills the screen, with an attention strip under the tabs (`⚠ 4 need you: …`, or `✓ all quiet`). Next and the hint are pinned to the bottom rows. A short terminal drops the strip, filter and Next before the footer. New `src/cli/tui/overview.tsx`, `test/dashboard-overview.test.ts`; `smoke.py` presses one more Tab.

- **Dashboard: stable columns per tab, owner before the title, host column, `s` sorts** (`tui_u4_columns`, dogfood items 2a and 6; [PLAN](docs/mu-next/tui-dogfood/PLAN.md) U4). Every tab now lays its rows out with `columns.ts`, widths taken from the whole snapshot of the workstream (never the filtered or scrolled rows), so a filter or a poll cannot move a column. Tasks: id (cap 24), status (fixed at `CLOSED/superseded`), owner, then the title as the one clip column, so a long title no longer cuts the owner off. DAG: indent-carrying id, status, title and notes (the `[ ]` brackets are gone). Agents: name, host (`dev` or `local`; replaces `name@host`), state (fixed at `needs_permission`), task, tool. Log: right-aligned seq, time, text (the scope column is gone: the log is per workstream). Keys: `s` on Tasks cycles the sort activity → roi (`impact/effort_days`, ties to the smaller effort) → age (oldest first, new `DashboardTask.created_at`) → id; the status filter moved to `o`. The filter line shows `sort: roi ↓`; `c` resets sort too. Tests: `test/dashboard-tabs.test.ts`.

- **Dashboard geometry modules** (`tui_u2_geometry`, dogfood items 1 and 6; [PLAN](docs/mu-next/tui-dogfood/PLAN.md) U2). Pure, plain-text building blocks ported from the 3.x render rules, not yet wired into the screen: `src/cli/tui/columns.ts` (protected columns never cut, one clip column ending in `…`, widths from the rows the caller passes so a filter or poll cannot move a column), `frame.tsx` (rounded frame, title and count in the top border, `+N more` in the bottom, always exactly width x height) and `grid.ts` (1/2/3 columns at <120/120/180 cols, a fixed card placement table instead of 3.x's hysteresis, min/max row budgets whose spare rows go to the cards hiding data so a column fills its height). 48 unit tests in `test/tui-geometry.test.ts`.

- **Dashboard read model: `attention[]` and `created_at`** (`tui_u3_attention`, dogfood item 4). `loadDashboard` returns `attention`, the trouble a human must see from the first screen, over every live workstream and blind to the status, text and workstream filters: `dead` (pane gone, or a gate's process exited), `permission` (with age), `input` (the `idle` flag: `needs_input` past `MU_IDLE_THRESHOLD_MS` while owning work), `stalled` (one tool over 15 min, `STALLED_TOOL_MS`), `human` (an OPEN `kind=human` task, whoever recorded it: `human_needs` stays caller-scoped and is empty for a human shell), `next_unavailable`, and `sync` (from the new `DashboardOptions.syncWarnings`). Most urgent kind first; each item has a drill `target`. Tasks carry `created_at` for an age sort. Agents are now read for every live workstream (Attention needs them); `agents` is still narrowed by scope and text. Data only, no UI yet (U6). Tests: `test/dashboard-data.test.ts`.
- **Dashboard `a` attach says how to get back, and nests on purpose** (`tui_u5_attach`, dogfood item 2b). `$TMUX` counted as "inside" whatever server it named, so the kit (which unset it) nested blindly and only `C-b C-b d` got the human back. tmux `attachCommands` now compares `$TMUX`'s socket with `MU_TMUX_SOCKET`: same server → `switch-client` (hint `a attach (back: C-b L)`); another server → `attach-session` marked `nested`, run with `TMUX` removed (the copied line reads `env -u TMUX tmux ...`; hint `a attach (detach: C-b C-b d)`). Before the handoff the terminal gets one line: `attaching mu-x:worker-1 · detach: C-b d (nested: C-b C-b d)`. `currentSessionName` ignores a foreign `$TMUX` too. The dogfood kit keeps `$TMUX` and takes `MU_DOGFOOD_SOCKET`. Verified in real nested tmux on private sockets, both paths. Tests: `test/tmux.test.ts`, `test/dashboard-drill.test.ts`, `test/spawn-ctl.test.ts`.

- **Dashboard: Agents and Log follow the workstream switch (`[` `]`); remote agents say `@host`** (`tui_ws_switch_bug`, dogfood items 5 and 7). Both tabs listed every workstream, so cycling changed Tasks and DAG only. Every tab now shows the selected workstream; agent rows use the bare name (`worker-1`), a remote agent `worker-1@dev`, and a task of another workstream keeps its qualifier. Filters and cursors on Agents and Log are per workstream like the others. The Log tail is read per workstream (`DashboardOptions.logWorkstream`), so a quiet workstream is not pushed out of the 100-op tail by a busy one. Scenario 7 was seeded right (`worker-1` on host `dev`, `worker-2` local): the old rows had no host marker at all. Tests: `test/dashboard-tabs.test.ts`, `test/dashboard-data.test.ts`.
- **The `course check due` notice is an instruction, and SKILL.md has a bullet for it** (`course_check_ab`). The notice now reads `course check due: <n> closed since <date>. Stop dispatching: finish merging, then follow recipes/course-correct.md`; SKILL.md gains the bullet "`course check due` stops dispatch: finish merging, then course-correct to its `mu human-needed`" (555 → 569 words). Why both: on haiku ×5 the `course_check` scenario passed 0/5 on the base, 2/5 with the bullet alone, 2/5 with the notice alone, 5/5 with both (303k tokens/rep vs 593k base), and the neighbours (`wait_interrupted`, `delegate_saturation`, `refute_verdicts`) held: `delegate_saturation` and `refute_verdicts` 5/5 on every variant, `wait_interrupted` 4/5 on a, b and c against 5/5 on base (a and b missed on a fixture timing, c on one re-sent task; n=5), no destructive runs. Log: docs/mu-next/eval/hillclimb-skill.jsonl.

- **Skill: SKILL.md drops the JSON-envelope paragraph** (`t_skill` step 3, 597 → 555 words). The envelope, error document, collection and key shapes are in `--help` and each result's own `next`. R4 on haiku ×3 over 14 non-holdout scenarios: cost −470k/rep, inside the 694k rep spread, destructive 0, completed 35 → 38/42, so the shorter text wins the tie. Log: docs/mu-next/eval/hillclimb-skill.jsonl.

- **Guide: Run mu with other agent CLIs** (`dogfood_harnesses`, [docs/guide/other-agent-clis.md](docs/guide/other-agent-clis.md)). Pinning which `mu` a codex or cursor-agent shell runs (their tools re-source `~/.zshrc`; `codex --disable shell_snapshot`, an empty `ZDOTDIR`), a tmux worker started with its prompt as an argument, waiting on `task:` refs, delegation through `scratch`, and what works with no multiplexer. The report is [docs/mu-next/eval/harnesses.md](docs/mu-next/eval/harnesses.md).

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

- **Surface milestone measurement** (`v_health`, [docs/test-health/2026-10-23-surface.md](docs/test-health/2026-10-23-surface.md)). Fast tier 217 files / 4720 tests and full suite 302 / 5691 (3 environmental skips), all green. Both gate budgets are over on the shared host: fast ~49 s (budget 30 s), `npm run test` 8m31s (budget 5 min). The suite doubled since the kernel milestone. Test-only speed-ups with unchanged counts: `cli-json-wire-matrix` seeds a template DB once (36 s → 3 s) and the `extension-mu-run` TERM-trap test no longer waits on its own leaked `sleep` (10 s → 0.3 s), both mutation-checked. Top-20 classified; no MERGE or DELETE. Main remaining cost: fresh `openDb` is 48% of fast-tier time (follow-up: a shared template-DB helper). `docs/ARCHITECTURE.md` gains rows for `src/cli/doctor.ts`, `src/cli/tasks/wire.ts` and `extension/delegate-process-format.ts`.
- **Shared template DB for tests** (`fast_gate_budget`). globalSetup builds one schema DB with the real `openDb`; a setup file routes every test `openDb` on a new path through a copy of it, re-keyed with its own `machine_identity`. Fast tier ~49 s → ~42 s wall, summed file time 329 s → 246 s (3 runs each, shared host); counts unchanged (217 / 4722). `db.test.ts` and `capture-persistent.test.ts` opt out to keep the fresh-file path pinned. Mutation-checked: skipping the re-key fails 85 tests.
- **Test harness fixes** (`rr_fix_r6_harness`, R6 review). The agent-guards-race "staged spawn" test polled the agent row, which `prestageLocked` inserts before `git worktree add`; it now polls the worktree (15/15 under 12 busy loops, was 2/15). The 43 real-tmux tests ran only from a shell inside tmux; `tmuxIntegrationAvailable()` is now true whenever globalSetup's private socket is up (one helper, the 4 placeholder skips are gone), and the setup file pins `MU_MUX=tmux` so mocked-tmux files no longer need an ambient `$TMUX_PANE`. Test scratch no longer leaks: globalSetup makes one per-run dir (forks' XDG roots live in it), removes it in teardown, unlinks the private socket file after `kill-server`, and sweeps the server, socket and scratch dir of runs whose pid is gone. `mu doctor --deep` runs `PRAGMA quick_check` (row `integrity`, exit 5 on anything but `ok`; shallow doctor says it skipped it), with `test/cli-doctor-db.test.ts` pinning the db block. The README kernel table cites real test files. The three `executeNext` suites share `test/_next-fakes.ts`. P3 nits: stale vitest comments, the pi-package source-grep test, the permanent reftable skip, brief-never-`cd` and refresh-must-fetch guards, test/README tiers, AGENTS.md "Today" marked stale.

### Fixed

- **One incarnation fence on every ctl op** (`rr_fix_r3_fence`; `rr_r3_session_ignores_fence` P2, `rr_r3_send_unbound_incarnation` and `rr_r3_interrupt_unbound_incarnation` P3, one root cause). `expectIncarnation` was opt-in per op and only `send`/`fresh` carried it: `/new`, `/reload` and `/compact` ignored an explicit fence (an SDK caller naming the old pi could reset the replacement), and `send --interrupt` read the hello's incarnation but never put it on the request. `command` and `interrupt` now carry it and the extension refuses a mismatch before any session change, abort or dispatch. A caller that gives none is fenced to the incarnation its own hello named, on all four ops. New hello feature `fence`: an extension that lacks it ignores the field on `interrupt`/`command`, so the implicit fence is skipped there and an explicit one is refused (`AgentExtensionOutdatedError`, op `fence`) rather than silently dropped. `interruptAgent` takes `expectIncarnation`. Tests: `test/agent-transport.test.ts`, `test/agent-interrupt.test.ts`, `test/extension-mu-pi.test.ts`. Mutation-checked: dropping the default binding, the extension check on `interrupt` or on `command`, or the client's field on either turns the matching test red.
- **A pretty-printed JSON `mu log` line no longer wedges every peer's sync** (`rr_r1_multiline_json_segment`, P1). The segment writer passed valid JSON through byte for byte, raw LF included, so `mu log $'{\n  "x": 1\n}'` wrote one op as three physical lines. Each peer stopped at `torn-write` and never applied a later op from this machine. `appendLog` now stores JSON that spans several lines with its line breaks and the whitespace around them removed: in JSON these can only sit between tokens, so the value is unchanged. It does not re-serialise, which would round big numbers. Prose keeps its newlines (the segment escapes it). `encodeSegmentLine` now throws on a payload that would still span lines. Tests: `test/segments.test.ts` (pretty JSON with CR/LF: one line, a peer applies it with no defect and stores the same bytes, a second flush appends nothing; the encoder refuses LF and CR).
- **A multi-line JSON log row stored by an older build no longer blocks flush forever** (`rr_fix_r1_segments_legacy`, P1). `appendLog` only strips line breaks from new appends; a row stored before that fix kept its raw LF, `encodeSegmentLine` threw on it, and every flush stopped at that row, so peers never got it or any later op. The encoder now applies the same value-preserving strip (`singleLinePayload`, moved to `src/segment-line.ts`) before the defensive line-break check. A peer stores the minified bytes. Test: `test/segments.test.ts` (seeded legacy row plus an ordinary log: flush appends both, the peer applies all ops with no defect, a second flush appends 0).
- **A log text that is a JSON string scalar reaches a peer byte for byte** (`rr_r1_string_scalar_unwrap`, P2, pre-existing). `mu log '"hello"'` is valid JSON, so the encoder passed it through, and the decoder unwrapped any JSON string whose contents are not JSON: the peer stored `hello`. The encoder now wraps a stored JSON string scalar like prose, and the decoder unwraps a string whose contents are not JSON or are a JSON string. A line written by an older build still decodes as before. Test: `test/segments.test.ts` (`"hello"`, a quoted JSON object, prose, `""`, a number and an object all round-trip unchanged).
- **A log line can no longer be left out of the segment for good** (`rr_r1_log_clock_append_race`, P2). `appendLog` committed its HLC mint and its ops INSERT separately. If another process appended and flushed between the two, the later op was published first, and every later flush (`hlc > last published`) skipped the earlier one. The mint and the INSERT now run in one `BEGIN IMMEDIATE` transaction, so ops commit in hlc order. Test: `test/logs-append-atomic.test.ts` (two connections; the second appends inside the first's window and gets `SQLITE_BUSY`, so commit order equals hlc order).
- **`mu rebuild` reads its source in one snapshot and moves the clock past the newest copied op** (`rr_fix_r1_rebuild`; pre-release review R1, P2). The identity, ops, peers and loss counts were four separate reads. A clock-skewed peer op ingested between them was copied, but the older clock was carried, so the next local edit minted an HLC below it and a second rebuild restored the peer's value over the later edit. The reads now run in one transaction, and the rebuilt clock is raised to the newest copied HLC (never lowered), which also covers a stale carried clock from any cause. Tests: `test/rebuild.test.ts` (racing future-HLC ingest, stale source clock); mutation-checked (each fix alone fails its test).

- **`mu sql --write` edits that a rebuild or peer replayed wrong are refused or fixed** (`rr_fix_r1_sqlguards`, `CAPTURE_VERSION` 5; pre-release review R1, P2s). (1) A local `UPDATE` of a note's `author`, `content` or `created_at` (the old guard covered only `kind`) now raises: the log replayed it as a second note with a wrong author, and a rebuild diverged from live. (2) A note tombstone is `{}` only when the newest put under its key describes the deleted note (same author, content, created_at); otherwise it carries the full row. After a rebuild reassigns note ids, deleting a note whose id was reused killed the wrong note on the next rebuild and resurrected it. `mu db compact` applies the same rule. (3) A local `UPDATE` of an edge's `created_at` raises (set once): the fold reads only the first put. Ingest (`applying = 1`) is never refused. Tests: `test/sql-guards-replay.test.ts`, `test/compact.test.ts`; mutation-checked (each guard and the tombstone rule). Existing tests that edited notes through SQL now use `withCaptureSuppressed`.
- **A failed remote spawn whose rollback removed its worktree leaves no `remote_recovery` record** (`triage_dff_remote_recovery_pileup`, dogfood-full F2). Four `spawn --host dev --worktree --task` attempts that failed on `ctl refused` each left a record for one path, though each rollback had removed the tree. `agent close` then refused (`pass --recovery <id>`, then `newer recovery … owns`), and clearing them took 8 calls, 3 of them `worktree already gone`. `removeRemoteWorktree` now reports whether the tree is proven gone (an `MU_RM removed|gone|moved|dirty` line; not just exit 0), and `rollbackSpawn` deletes the row with `preserve: false` only then. A tree it left alone (HEAD moved, changes, unreachable host) keeps its record. Tests: `test/remote-spawn.test.ts` (the 4-attempt repro, and a left-alone tree keeps its record), `test/remote-spawn.integration.test.ts` (real git: removed means no record, a moved HEAD keeps one). Mutation-checked: always preserving turns the repro red; trusting exit 0 turns the left-alone test red.
- **One owner death is one `dead` event** (`dead_double_event`, p3_leftovers_post (b)). `claim --for` registers the task and its owner, so one death came back as two exit-6 waits: `dead` on the task, then `dead` on the agent. `select()` now folds the agent's `dead` into the task's (first and `--all`), as it already folds a settled run into the close its CLOSE block made: one event, the task as its ref, both refs `dead` in `refs[]`, both cursors written in the same delivery. Same death = the same registry row, or, after the reaper deleted the row, the owner the task names (a live tick, or the claim op's actor in the ops log, `reapFlip`). An unrelated agent's death, or a respawn under the dead owner's name (another row), stays its own event. Tests: `test/wait-delivery.test.ts` (pane gone, reaped, `--all`, two deaths); mutation-checked (drop either fold, the name fallback, or the row check).
- **A due course check now shows** (`f_course_hint_unwired`). `computeNotices` had no CLI caller, so the course-correct trigger never fired. `mu state` and `mu wait` now carry it as `data.notices: ["course check due: <n> closed since <date> (recipes/course-correct.md)"]`, one line per workstream in scope (a wait's `-w`, else its refs' workstreams). The key is absent when nothing is due; the success envelope keeps exactly `{ok,data,next}`.
- **A worker whose shell rc reset mu's env cannot write or sync** (`triage_dfh_harness_path`, P1). codex and cursor-agent run every tool command through the user's interactive shell rc, which can reset `PATH` and `MU_*` after mu set them. In the dogfood that sent a worker's `mu` to the real sync folder. A local spawn now also sets `MU_PANE_ENV` (the DB, state dir and sync dir it used). A mu-next run in that pane that resolves different ones (a sync dir the pane did not have counts; sync turned off does not) opens the DB read-only and skips ambient sync. A read prints one warning; a write, or a DB missing at the new path, is `PaneEnvMismatchError` (exit 4, nothing created). `MU_ALLOW_FOREIGN_DB=1` overrides. `agent spawn --cli codex|cursor-agent` warns once (in `warnings` under `--json`) unless the command already has `--disable shell_snapshot` or `ZDOTDIR=`. Verified: mu-next refuses a 3.x DB (`SchemaTooOldError`, exit 4, file byte-identical). An older `mu` first on `PATH` cannot be caught; [docs/guide/other-agent-clis.md](docs/guide/other-agent-clis.md) says how to pin it.
- **A due course check now shows** (`f_course_hint_unwired`). `computeNotices` had no CLI caller, so the course-correct trigger never fired. `mu state` and `mu wait` now carry it as `data.notices: ["course check due: <n> closed since <date>. Stop dispatching: finish merging, then follow recipes/course-correct.md"]`, one line per workstream in scope (a wait's `-w`, else its refs' workstreams). The key is absent when nothing is due; the success envelope keeps exactly `{ok,data,next}`.
- **`task claim --for` no longer suggests a send tmux refuses** (`dogfood_harnesses`). For a non-pi owner (codex, cursor-agent, claude) on tmux, `next` was `mu agent send <w> 'Claim done: ...'`, which exits 4 (`AgentSendUnsupportedError`). The claim now offers no send there; herdr and pi owners keep theirs. The refusal itself names the tmux route that works: start the agent with the prompt as an argument (`--command "<cli> '<prompt>'"`).
- **`mu wait -w <ws> --wave <label>` sees the wave** (`triage_dff_wave_scope`, dogfood-full F1). The scope narrowed the wave to calls in `<ws>` or recorded on it, but `mu_delegate` defaults to `scratch`, so every wait from the orchestrator-loop recipe tallied `0/0 CONFIRMED` (or said `nothing to wait for`) while the answers sat done, and the orchestrator fell back to `sleep 40` loops. A wave is already the caller's, so `-w` no longer narrows it (it still narrows owned refs). A wave name none of the callers' calls carry is `no such wave: <name> (your waves: ...)` (`WaveNotFoundError`, exit 3) instead of `nothing to wait for`. Tests: `test/wait-surface-engine.test.ts`, `test/wait-cli.test.ts` (mutation-checked: restoring the scope filter turns 3 red; dropping the unknown-wave guard turns 2 red).
- **`next: mu wait` follows only a command that armed work** (`p3_leftovers_post`, docs_final_p3 (a)). The bare wait over owned refs followed every command (a `task show`, an unrelated update) while the caller owed anything. `computeNext` takes `armed`; the CLI sets it when the verb registered refs (`armWait`: `send`, `spawn --send`, `claim --for`). The dashboard (no verb) is unchanged. Tests: `test/next-hints.test.ts`, `test/next-finalise.test.ts` (mutation-checked: drop the guard).
- **`mu task notes` consumes a delegate answer only when it showed the report** (`fix_notes_consume_shown`). The read consumed before it built the page, so `--tail 1`, `--from 3`, an empty `--since`, even a `--from 999` error took the answer unseen and the owned wait then returned nothing (the settle's human-stop drain and the wave loop skipped it too). `consumeReadReport` now runs after the page is emitted and takes the set of notes shown whole: the call's last `report` note must be in it (a cut stub or an omitted note does not count). Tests: `test/delegate-read-delivers.test.ts` (mutation-checked: consume before the page; ignore report-in-items).
- **A delegate answer read with `mu task notes` is delivered** (`wait_owned_drain_v2`, dogfood-switch F2). Mid-turn the d8 orchestrator read each review with `mu task notes`, and each later explicit `mu wait agent:…` / `task:…` came back with one of those already-read answers (5 times), so it fell back to sleep loops. Its own caller (`currentCallers()`) reading a finished (`done`/`failed`/`cancelled`) delegate task now records that call's wait cursor (`consumeReadReport`); a running call, another caller's call, and a shell with no caller stay pure reads. No wait consumes beyond `firing` (the reverted 23b2afe did). `mu delegates list --json` rows carry `delivered`, and the settle's wave loop no longer waits for a sibling already taken. Tests: `test/delegate-read-delivers.test.ts`, `test/extension-delegate.test.ts`.
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
- **A new DB and state dir.** 4.0 keeps its state in `~/.local/state/mu-next`
  (`$XDG_STATE_HOME/mu-next`), schema 13. It never imports a 3.x DB: a DB older
  than v13 is refused (`SchemaTooOldError`, exit 4, file untouched). Open work
  moves one workstream at a time with the
  [move recipe](skills/mu/recipes/move.md). A `MU_SYNC_DIR` that holds a 3.x segment
  is refused (exit 4): give 4.0 its own sync folder. Sync segment lines are v2 only.
- **Scope is explicit.** Pass `-w <name>`, a qualified `<ws>/<id>` ref, or run as a
  spawned worker (its injected `MU_WORKSTREAM`). `$MU_SESSION` and the tmux session
  name no longer route a verb. An unknown `-w` is exit 3 on every verb.
- **One JSON document.** `--json` prints exactly `{ok, data, next}` on stdout,
  errors included, and every result's `next` is computed from state. Task reads
  (`list`, `next`, `show`, `tree`, `notes`) print bounded records (one escaped
  TAB-separated line per task, a result under 4 KB, a cut says how to get the rest).
  `mu state` and `mu me` are one canonical JSON document.
- **`mu wait` is the one wait, and `mu task wait` is its alias.** It prints one JSON
  result with no flag, returns on the first event the caller owns (`closed`,
  `settled`, `input`, `dead`, `stall`, `delegate`, ...), takes typed refs
  (`task:`, `agent:`, `delegate:`) or none, and a timeout is `ok:true` with exit 0.
  Default timeout and cap: 1500 s. `--all` keeps the all-of loop; `--resume <id>`
  restarts a cut wait losslessly.
- **Removed verbs and flags.** `mu link pi` (pi loads mu as a package; `mu pi migrate`
  moves an old shim aside), `mu workspace` and `--workspace*` (use
  `mu agent spawn --worktree [--from] [--root]`, `agent close --discard`), the jj, sl
  and `cp -a` workspace backends, `mu undo`, `mu agent kick`, `mu agent adopt`,
  `mu agent remote-env`, `mu agent send --via`, `--strict-staleness`, the card TUI,
  the v7-v10 migration sidecar, pane titles and borders, and the env vars
  `MU_SEND_DELAY_MS`, `MU_SEND_READINESS_MS`, `MU_BANNER_QUIET`, `MU_NO_TUI`,
  `MU_TUI_DEBUG_MOUSE`, `MU_EXTENSION_ENTRY`.
- **tmux no longer pastes into non-pi agents.** `mu agent send` to a non-pi agent on
  tmux is refused (`AgentSendUnsupportedError`, exit 4); start the agent with its prompt
  as an argument. pi agents use the control socket and herdr uses its atomic
  `agent prompt`.
- **Teardown is soft and previewed.** `mu workstream teardown` prints counts and
  `rev=<n>`; `--if <n>` applies. Tasks and notes stay, hidden. `mu agent close` and
  `mu task delete|block|unblock|reparent|claim|release` take the same `--if <rev>` guard.
- **Identity is `$MU_AGENT_NAME` only.** Spawn injects exactly six variables
  (`MU_MANAGED_AGENT`, `MU_AGENT_NAME`, `MU_WORKSTREAM`, `MU_CTL_SOCK`, `MU_DB_PATH`,
  `MU_STATE_DIR`), plus `SSH_AUTH_SOCK` forwarding.
- **`mu sql` and `mu db query` read by default.** A write needs `--write` and is one
  captured op group; non-read-only PRAGMAs, `BEGIN`, edits that would diverge a rebuild,
  and writes to capture state are refused.
- **Delegate answers come through the settle wait.** The pi follow-up echo of the
  answer text is gone; the continuation carries the call's report.

### Added

- **Delegates are durable tasks.** Every `mu_delegate` call is a `kind=delegate` task
  (default workstream `scratch`) with the prompt as its brief and the answer as its
  report, under `mu delegates` (`register`, `list`, `show`, `tally`, `reissue`).
  `mu_delegate_reissue` retries a refused call; a `wave` label groups a fan-out and
  tallies its verdicts. Delegates survive `/reload`.
- **Delegates need no multiplexer.** With no tmux or herdr, a call runs as a child
  `pi --mode rpc` (`mu delegates run`), with the same admission, queue, refusal and cancel.
- **`mu next` and `mu task auto`.** Explicit, host-fenced permission for judgement-free
  moves: `mu next` recovers dead or errored workers and spawns ready ones, with
  `--dry`, `--hold`, `--cap` and `--workers`. It never accepts or merges.
- **Task graph.** `mu task add` takes several ids and `--blocks`; `--triage` and
  `mu task accept` keep review findings out of `next` until accepted; `mu task open`;
  `--if <rev>` guards; `mu human-needed <reason>` records the loop's one legitimate
  stop for a person's decision.
- **Remote workers.** `mu host add|list|show|rm|init|check` store ssh-free host
  profiles; `mu agent spawn --host <profile> [--worktree] --task <id> --send ...`
  starts a remote worker; `mu agent collect` brings its commits home; a remote
  recovery record keeps a removed worker's worktree reachable.
- **Exact agent control.** `mu agent send` returns a receipt (`msgId`, `incarnation`,
  `delivery`); `mu agent check <agent> <msgId>` settles an unknown delivery;
  `mu wait agent:<name>#<incarnation>` refuses a restarted pi; every control-socket op
  is fenced to the incarnation the caller saw.
- **`mu wait` armed by what you started.** `spawn --send`, `spawn --task`, `send` and
  `task claim --for` register what the next bare `mu wait` owes; the extension's settle
  wait keeps an orchestrator driving until nothing is owed or a human stop is open.
- **A live dashboard.** Bare `mu` on a TTY opens a read-only ink dashboard: Overview,
  Tasks, DAG, Agents and Log tabs, drills into notes, scrollback and log entries,
  workstream switch, filters, `y` yank over OSC 52, `a` attach. It polls, never writes,
  and runs ambient sync on its own connection.
- **Sync and recovery.** The ops-capture triggers live in the DB file, so any plain write
  is captured; `mu rebuild` replays the ops log into a new DB from one snapshot;
  `mu db backup|compact|forget`; `mu doctor` rows for `mu ext`, `ctl` and the DB.
- **The skill and recipes.** One capped `mu` skill, twelve recipes and nine pi prompts
  (`/ultrathink`, `/mu-review`, `/mu-refute`, ...), measured against an eval matrix.
  A due course check shows as a notice on `mu state` and `mu wait`.
- **Guides.** [Run mu with other agent CLIs](docs/guide/other-agent-clis.md): pin which
  `mu` a codex or cursor-agent shell runs, start a tmux worker with its prompt as an
  argument, and what works with no multiplexer.
- **Docs for 4.0.** The README states 4.0 and shows the dashboard
  (`docs/img/tui-dashboard.png`, drafted by `tools/screenshot/dashboard.sh`).
  The upgrade guide covers 3.x to 4.0, keeping 3.x runnable for the Move
  recipe, and rollback. `MU_TMUX_SOCKET` is documented as a private-server
  switch, and the remote guide says which wait applies a `CLOSE:` block.

### Changed

- **Worktrees replace workspaces.** `mu agent spawn <name> --worktree` runs
  `git worktree add --detach` under the state dir; the pane's cwd is the worktree.
  `agents.cwd` and `agents.base` record where and from which commit.
- **Task claims and closes carry evidence.** `task close --as done` needs `--evidence` (or `--note`);
  a worker's `CLOSE:` block closes its task, and a malformed one ends a wait with a
  reason instead of hanging it.
- **`mu agent wait` on a non-pi agent fires only on busy to not busy**, as in 3.x: with
  no murmur state it runs to its timeout, so wait on `task:` refs.

### Test health

- Fast tier 217 files / 4720 tests, full suite 302 / 5691 (3 environmental skips), all
  green at the surface milestone; both gate budgets were over on the shared host
  ([record](docs/test-health/2026-10-23-surface.md)).

## [3.13.3] — 2026-10-22

**Test upkeep leaves a record.** An upkeep pass now ends by committing a
dated report to the repo, so its findings outlive the workstream.

Upgrade with `npm i -g @mu-crew/mu@3.13.3`. New agent sessions load the updated
skill. No CLI, API, schema or extension change.

### Changed

- **Skill: test upkeep ends with a committed report.** The
  [test-health](skills/mu/recipes/test-health.md#upkeep) loop gains a
  sixth step: a dated `docs/test-health/` report in the repo, holding the
  findings and every refuted or rejected verdict, so the next pass starts
  from them instead of from scratch when the workstream's notes are gone.

## [3.13.2] — 2026-10-21

**Keep verification useful as projects grow.** The mu skill now defines
fast/slow gate responsibilities, scoped evidence reuse and routine test upkeep.

Upgrade with `npm i -g @mu-crew/mu@3.13.2`. New agent sessions load the updated
skill. Existing workers need updated briefs; no schema or extension change.

### Changed

- **Skill: fast/slow gates and routine test upkeep.** Canonical
  [test-health](skills/mu/recipes/test-health.md) guidance assigns targeted
  worker/reviewer checks, equivalent gate records and one full merged-tree
  gate per batch. Milestones and budget crossings prioritise upkeep without
  a crew-wide barrier; auth/build isolation and required pre-push checks stay.
  mu's own gate commands remain unchanged pending review.
  Pilot baseline supplied for swaywardlock `90c3f1c`: cold full 557.885 s,
  fast 216.140 s, slow 341.696 s (e2e 255.561 s, release 82.414 s);
  223 unit tests ~1 s, 64 e2e cases / 422 assertions, no skips. Converters
  initially cost ~28 s in fast: fast is not universally seconds. This is
  pilot timing, not an equivalent gate record for mu. A separate targeted
  vibrancy-wait follow-up preserved all seven assertions and reduced that
  case's mean from 3.350 s to 2.140 s; it does not establish a full-gate
  speedup or a solved budget.

## [3.13.1] — 2026-10-20

**jj 0.46: recreating a deleted workspace works again.** A spawn that reuses
the name of a jj workspace whose directory was deleted failed on jj 0.46.

Upgrade with `npm i -g @mu-crew/mu@3.13.1`. No schema or extension change.

### Fixed

- **A jj workspace whose directory was deleted can be recreated (jj 0.46).**
  `mu agent spawn --workspace` forgets a stale jj workspace of the same
  name first. jj 0.46 keeps printing the deleted path as the workspace
  root, so mu missed it, and in a colocated repo the workspace is also a
  Git worktree that `jj workspace forget` leaves registered. mu now checks
  the root on disk and runs `git worktree prune` after the forget, so the
  re-add no longer fails with "Workspace named … already exists" or
  "missing but already registered worktree".

## [3.13.0] — 2026-10-20

**Faster everyday verbs.** tmux-touching verbs no longer load execa (about
50-60 ms each), pure-JS dependencies are bundled, and a bare verb in a
mu-spawned pane skips the tmux workstream lookup. `mu doctor` counts ops by
key range (~250 ms less), peer sync resumes from where it stopped, and the
TUI launches faster and stops re-detecting the VCS every 10 s.

Upgrade with `npm i -g @mu-crew/mu@3.13.0`, then `/reload` in running pi
sessions to pick up the extension. No schema change. Task, track and peer
lists now sort names by code unit (`a-b, a0, a_b`; uppercase first).

### Changed

- **Spawn warns on Claude's folder-trust dialog.** The dialog defaults to
  "No, exit", so the Enter that ends `--send` quit claude. The tmux
  startup scan now spots it (non-fatal): the pane and agent stay, the
  initial `--send` is skipped (`send.error` `TrustDialogPending` in
  `--json`), and a warning plus next step says to answer it in the pane
  and then `mu agent send`. It does not guard a later `agent send` or the
  herdr spawn path, and mu never presses a key for you.
- **TUI dashboard fills its space.** A card's `maxRows` now caps only
  the first pass of the row allocator: leftover rows go to cards whose
  data still overflows, in proportion to the rows each hides, so a
  40-item Ready list at 80 rows shows all 40 instead of 15 above 60
  blank rows. Cards also move between columns: `arrangeColumns`
  (replacing `balanceColumns`, which only ran after a cull) searches
  single moves and swaps for the fewest hidden rows, even with all ten
  cards visible, and keeps the previous layout unless the new one hides
  max(3, 10%) fewer rows. The search also descends from the previous
  layout, so a retained layout never has a single move or swap that
  beats it by more than that margin. Among layouts that hide the same rows, the search
  prefers fewer cards away from their default column, then slot order. Footers and mouse hit regions read the same
  budgets (`columnRowBudgets`).


- **Skill: recipe wording from a prior runtime.** An `unknown` owner
  is not a dead one: orchestrator-loop says to read the pane or run
  `mu doctor` before releasing its task. Reviews with only
  UNVERIFIED items go to the human, not into a REJECT round. findings § Record
  grades severity strictly (critical needs a concrete scenario).
  ultrathink and loop-until-done refute the umbrella's criteria on the
  merged tree before `close --if-ready`.
  watcher caps attempts per item and parks it with every attempt listed.
  long-run records `DEAD-END:` notes on the umbrella.
  backlog-triage re-verifies an item against the code before starting.
  dag.md states that every edge comes from a verb the caller ran (`block`, `add`/`reparent --blocked-by`) and no write adds edges on its own.
  VISION cites a prior runtime's transport and sentinel-marker lessons.
- **A changed peer segment is ingested from where the last read stopped.**
  Every append used to make each other machine hash the whole segment,
  read it a second time as text and split it (~120 ms for this fleet's
  64 MB segment, ~9 ms of it needed). A clean read now saves the byte
  offset and running sha256 state next to the caught-up fingerprint; the
  next ambient ingest reads only the appended bytes, and accepts them
  only when their hash is the manifest's sha256 (~20 ms). A shrunk
  file, a stale manifest, a defect (which saves no offset) and `mu sync`
  take the full read and whole-file verify as before. The resumed hash
  trusts the prefix it already read: a local edit to those earlier bytes
  that keeps the file growing is caught only by `mu sync`, not by the
  ambient ingest. No
  schema change: the offset is extra fields in the existing
  `sync_fingerprints` value, which an older mu never matches and
  ignores.
- **`mu workstream list` reads mux liveness from one `list-sessions`.**
  It also ran `has-session` once per workstream (6 spawns for 6
  workstreams). The listing now reuses the session names it already
  fetched, and falls back to per-workstream `has-session` when
  `list-sessions` fails, so a transient failure still never marks live
  sessions dead. ~22 ms CLI CPU saved; output is identical.
- **`mu_delegate` lists agents at most every 30 s while a failed delegate
  lingers.** Each spawn ran `mu agent list` (~150 ms of CPU) only to prune
  the footer's failed count; the refresh is now throttled to once per
  30 s. Spawning and safety checks are unchanged; the footer may show a
  closed failure for up to 30 s longer.
- **`mu agent spawn` sets the tmux pane border in one tmux call.** The four
  `set-option -w` calls are `;`-chained into one invocation and target the
  pane directly, which drops the `display-message #{window_id}` lookup
  (the border helper's 5 tmux processes become 1, ~33-80 ms per spawn). Options, `-w` scope,
  `MU_BANNER_QUIET`, and the swallow-all-errors behaviour are unchanged.
- **The TUI detects the VCS backend once, not every 10 s.** The slow tick
  ran `jj root`, `sl root` (twice) and `git rev-parse` before every
  `git log` just to learn the same backend again. It now caches the
  backend per project root for the TUI's lifetime (~4 of 5 processes per
  tick; ticks after the first dropped from ~690 to ~175 ms best case on
  a loaded machine). A `none` result is not cached, nor is a detection
  during which a root probe failed (spawn error, signal) rather than
  cleanly answering "not this VCS": a transient `jj root` failure in a
  colocated jj/git repo no longer pins git. `mu state` is unchanged (it
  never probes the VCS).
- **The TUI bundles ink and react into its lazy chunk.** Importing the TUI
  resolved and compiled ~560 ESM files from `node_modules` per launch. tsup
  now inlines ink, react and their pure-JS deps into `dist/tui-*.js` (loaded
  only by bare `mu` and `mu state --tui`; other verbs are unchanged), using
  the createRequire banner from the commander/cli-table3 bundling. NODE_ENV
  is not defined at build time, so `src/cli/tui-load.ts` still picks react's
  production build at runtime and an explicit `NODE_ENV` still wins. TUI
  import ~470 -> ~67 ms, first Agents card ~890 -> ~440 ms (PTY, 20
  alternating launches on a copied DB). `react-devtools-core` stays external
  (ink loads it only under `DEV=true`).
- **Task, track and sync-peer sorts use code-unit order, not
  `localeCompare`.** The first `localeCompare` call initialised ICU
  (~4 ms on nearly every list verb). Ties by name now sort by code unit,
  so `a-b, a0, a_b` replaces the locale order `a_b, a-b, a0`; uppercase
  sorts before lowercase. Sort keys, ROI order and everything else are
  unchanged.
- **`mu doctor` and `mu db forget` count a workstream's ops by key range.**
  The per-workstream `substr(key, …)` test scanned all of `ops` once per
  torn-down workstream (27 scans of 61k rows, ~320 ms of SQL in
  `mu doctor`'s size hint). It now seeks `idx_ops_entity_key` with a key
  range per entity (~28 ms); counts and deleted rows are identical.
- **A bare verb in a mu-spawned pane skips the tmux lookup.** With no
  `-w` and no `$MU_SESSION`, `resolveWorkstream` ran `tmux
  display-message -p '#S'` (and loaded execa) even though spawn already
  put the workstream in `$MU_WORKSTREAM`. It now uses `$MU_WORKSTREAM`
  when `$MU_MANAGED_AGENT=1` is also set: bare `mu task list` ~133 -> ~67
  ms from an agent pane. `-w` and `$MU_SESSION` still win, and a
  `$MU_WORKSTREAM` without `$MU_MANAGED_AGENT` (a stale export in a user
  shell) is ignored. User-started orchestrator panes are unchanged.
- **Spawn sees a pi agent's control socket within ~50 ms.** The spawn
  handshake polled every 250 ms, so a socket pi bound just after a poll
  waited up to 250 ms to be noticed. It now stats the socket path every
  50 ms (no fork) and probes as soon as it exists: readiness overshoot
  132 -> 24 ms, ~100 ms less per pi spawn. The pane-alive check and
  scrollback capture keep their 250 ms cadence, plus one final check at
  the budget's deadline, so a pane dying in the last 250 ms keeps its
  crash scrollback.
- **`mu_delegate` closes the pane and writes the record note in
  parallel.** A finished delegate with `record` waited for
  `mu agent close` before starting `mu task note`, though neither needs
  the other. They now overlap: ~70 ms less before the answer arrives
  (median of 25 pairs), on clean finishes that close and record. Failure
  reporting is unchanged: a refused close and a failed note are each
  named in the follow-up.
- **The keep-driving nudge reads `mu task list`, not `mu state`.** At
  each armed settle the pi extension ran `mu state --json` only to read
  IN_PROGRESS task names, paying for the tmux pane listing and the
  orphan and workspace views it never used. It now runs
  `mu task list --status IN_PROGRESS --json` per dispatched workstream
  (`--sort recency`, newest first as `state` listed them), in parallel,
  deduplicated by task: ~56-69 ms less per armed settle (one
  workstream). A task still owned by a dead agent shows in the nudge until the next
  `mu state` or `mu task wait` reaps it.
- **Faster tmux-touching verbs.** The tmux, herdr, kick and murmur-status
  executors run through `node:child_process` instead of lazily importing
  execa (~110 modules, 25-40 ms). `mu state`, `mu agent list`, and bare
  verbs that resolve the workstream via tmux drop by ~50-60 ms per call
  (state ~140 -> ~85 ms). Output and exit codes are unchanged; capture
  keeps execa's 100 MiB buffer cap.
  In-flight children are killed when mu exits or gets SIGTERM, SIGINT or
  SIGHUP, as execa's `cleanup` did, so no tmux or murmur process outlives mu.
- **Faster startup: pure-JS dependencies are bundled.** Every verb
  resolved, read and compiled about 35 `node_modules` files (commander,
  cli-table3, string-width and their dependencies). `tsup` now bundles
  commander, cli-table3, string-width and picocolors into `dist/`
  (native `better-sqlite3`, `execa`, `ink` and `react` stay external; the TUI
  chunk is still lazy). Measured on interleaved warm runs: 5-15 ms per
  invocation (`--version`, `task list`, `state`).
- **Skill: orchestrators clean up scratch files.** Review panels and
  other delegate jobs left briefs, diffs and outputs in `/tmp` or ad
  hoc dirs under `$HOME`. SKILL.md's orchestrator rules now say to keep
  briefs and answers in task notes and `mu log` (stdin for pure
  delegate calls), keep any files in one `mktemp -d` dir per job,
  and remove it before the turn ends.
- **Skill: worker checkouts come from mu.** Orchestrators made their
  own `git worktree`s for workers, which mu could not refresh, diff or
  free, so they leaked. SKILL.md now says to use `--workspace` /
  `workspace: true` for every local agent; remote agents keep the
  manual recipe.

### Fixed

- **`mu log` names who sent, spawned or aborted.** `agent.send`,
  `agent.spawn` and a new `agent.abort` op (written only when a busy agent
  was actually aborted) carry the caller (`$MU_AGENT_NAME`, pane title,
  `$USER`) as their actor instead of `system`. The extension's `abort` reply
  now carries `wasBusy`, so a run that settles between the status probe and
  the abort is not logged.
- **A rolled-back spawn leaves an `agent.spawn_failed` log entry** with the
  phase reached and the error class; `agent.spawn` now carries `ctl=`.
- **Spawned panes get the caller's `SSH_AUTH_SOCK`.** mu sessions are
  created detached and can stay so, so tmux never refreshed the env and a
  pane could inherit a stale socket. Spawn now forwards it when it is set
  and a socket (file-type check only, no liveness probe).
- **Detached tmux sessions start at 200x50, not 80x24.** `mu agent read`
  captured wrapped lines at 80 columns on unattached sessions.
  `new-session -d` now passes `-x 200 -y 50` (attached sessions are
  unchanged; no `resize-window`). herdr is unaffected.

- **Nudges yield to a delegate answer on its way.** The keep-driving and
  close nudges continued a settling run even when a `mu_delegate` answer
  sat in pi's follow-up queue (pi's `hasPendingMessages()` does not count
  custom follow-ups), so the agent took an extra turn without the
  answer. All three nudges now skip while an answer is being delivered or
  queued, re-checking after their `mu` read and again once the slowest
  nudge's read finishes (the nudges run in parallel); keep-driving and close also
  skip while an extension dialog is open. A skipped settle does not use
  up the prompt's one nudge.
- **Spawned agents use the spawner's database.** Panes inherit the tmux
  server's env, so under `MU_DB_PATH=/tmp/x.db` a worker's `mu` hit the
  real DB. Local spawns now pin `MU_DB_PATH` (absolute, skipping
  `:memory:`) and `MU_STATE_DIR` in the pane env.
- **`mu doctor` reports dependency cycles made by sync.** Two machines can
  each add a locally valid edge that merge into a cycle, silently hiding its
  tasks from ready/next. A `dag` section (and `dagCycles` in `--json`) lists
  each cycle with a `mu task unblock … --by … -w …` command that breaks it.
  Report-only; the `task tree` header no longer claims the schema forbids cycles.

- **`mu agent send <agent> ""` no longer fails with tmux "no buffer".**
  On the mux path an empty message now presses a bare Enter (dismisses a
  "Press Enter" prompt). Over the pi control socket it is refused with
  `AgentEmptySendError`, whose next step is `--via mux`. herdr refuses an
  empty send (no verified bare-Enter primitive).

- **`paneExists` no longer reads a failed tmux probe as a dead pane.**
  Any nonzero `display-message` exit returned false, so a permission or
  socket error looked like "gone" to liveness gates such as
  `workspace free`. Only "can't find pane" / no-server answers mean
  false now; other failures throw, and callers fail closed.
- **Cycle errors name the full path.** `CycleError` now reads
  `adding edge c -> a would create a cycle: c -> a -> b -> c` and its
  next steps give a concrete `mu task unblock <b> --by <a> -w <ws>` for
  an edge on the path. `findCyclePath` (shortest path, safe on existing
  cycles) is exported from `src/tasks/edges.ts`.

- **Reconcile no longer deletes a respawned agent.** The ghost prune
  deleted by name, so an agent closed and respawned under the same name
  during a pass lost its new row and had its tasks reopened. The delete
  now checks the snapshotted pane id inside the reaper transaction and
  skips the row (and the ctl socket unlink) on a mismatch.
- **`mu agent send` no longer calls an ambiguous failure "refused".**
  When a send, fresh, interrupt or command request was already written
  to the control socket and the reply then timed out or the connection
  closed, pi may have queued the prompt. mu now raises
  `AgentSendIndeterminateError` (exit 1, "delivery unknown") whose next
  step is `mu agent read <agent> -w <ws> -n 20` before resending.
  Failures before the write, dead panes and status/wait/hello keep their
  old errors.
- **Send waits for Codex's "model: loading" screen.** The boot screen
  has no spinner, so `awaitPaneQuiescence` saw it as calm and pasted
  into a booting Codex, concatenating text. "model: loading" is now a
  busy marker (visible tail only).
- **`mu workspace free` refuses under a working agent.** It ran
  `worktree remove --force` beneath a running worker and lost its
  pending changes. It now exits 4 when the owner is busy, needs
  permission, or is unreadable with a live pane. Idle (`needs_input`),
  a dead pane and a pane-less row are allowed. `--force` skips only
  this check. `agent close` and spawn rollback are unchanged.
- **A pi agent stuck on an extension dialog reads `needs_permission`.**
  The control socket only knew busy / idle, so a pi waiting on a
  confirm or question mid-run read `busy`, and `mu agent wait` and
  `mu_delegate` held until their timeout (600 s / 3600 s). The mu pi
  extension now tracks pi's `ui_prompt_start` / `ui_prompt_end` and adds
  an optional `blocked: {kind, title, since}` to the status reply; `mu
  agent list`, `mu state` and `mu agent show` show `needs_permission:
  dialog <kind>: <title>`. A held `mu agent wait` on a pi agent ends
  early with outcome `blocked` (not fired, run counter unchanged) and
  exit 7. The `mu_delegate` follow-up says the delegate is blocked and
  has not finished, keeps the pane, and copies no partial answer. Older
  extensions send no field and ignore the new `returnOnBlocked` wait
  flag, so they behave as before. A held wait whose connection drops
  falls back to polling, and a dialog seen by that poll also ends the
  wait `blocked` (exit 7) rather than counting busy → needs_permission
  as a finished run. The blocked JSON row carries `afterRuns`, the run
  baseline the wait counted from, and the re-wait hint (CLI next steps
  and the `mu_delegate` follow-up, blocked or timed out) passes it as
  `--after-runs`, so a run that finishes after the dialog is answered
  but before the re-wait starts is returned rather than missed.
- **tmux panes keep their mu title.** pi sets an OSC title
  `π - <cwd>`, which overwrote the pane title mu uses as its identity
  fallback. Spawn and adopt (including idempotent re-adopt) now set
  `allow-set-title off` on the pane. herdr is unchanged.

## [3.12.0] — 2026-10-11

**A delegate that ends without an answer leaves its evidence.** Timeout,
API error, empty finish, dead pane or cancel: the follow-up names the
delegate's pi session file and copies its last message so far to
`~/.cache/mu/delegate-answers/`.

Upgrade with `npm i -g @mu-crew/mu@3.12.0`, then `/reload` in running
pi sessions to pick up the extension. No schema change. The session
file is reported by the delegate's own extension, so delegates need
3.12.0 too; an older one still gets the `mu agent read` pointer.

### Added

- **Delegates that end without an answer leave evidence.** A
  `mu_delegate` follow-up for an API error, an empty finish, a
  timeout or a dead pane, and the `mu_delegate_cancel` result, now
  name the delegate's pi session file and copy its last message so far
  to `~/.cache/mu/delegate-answers/<ts>_<name>.partial.md`. Before, the
  only pointer was `mu agent read`, which stops working once the pane
  is gone. Quitting pi or `/reload` lists each running delegate's
  session file too.
- **The control socket's `status` reports `sessionFile`**, so the reply
  to `mu agent spawn --send` / `mu agent send` carries it before any
  run settles.

## [3.11.3] — 2026-10-11

**Escape no longer loses delegate answers; spawn and DB-open fixes.**
An Escape that drops queued delegate answers leaves a pointer to each
one. A fresh DB survives a parallel fan-out, and `--next-free` skips
names whose workspace dir is left on disk.

Upgrade with `npm i -g @mu-crew/mu@3.11.3`, then `/reload` in running
pi sessions to pick up the extension. No schema change. Both sides of a
delegate need 3.11.3 for the session-file pointer: an older delegate
falls back to the copy and `mu agent read`.

### Added

- **Escape no longer loses queued delegate answers.** Escape clears
  pi's follow-up queue, so an answer waiting there was gone. The
  extension now copies each dropped answer to
  `~/.cache/mu/delegate-answers/` (`$XDG_CACHE_HOME/mu`) and writes
  one line per answer into the conversation, without starting a turn,
  naming the copy and the delegate's pi session file. The copy is
  cache: the session file keeps the original.
- **`mu agent wait --json` reports a pi agent's `sessionFile`**, the
  transcript of the run it waited for. The control socket's `wait`
  reply carries it.

### Fixed

- **`spawn --next-free` skips a name whose workspace dir is left on
  disk.** A dead agent's checkout outlives its row, kept as evidence.
  `--next-free` checked only agent rows, so it picked that name again,
  and `--workspace` then failed with `WorkspacePathNotEmptyError`
  instead of moving on. `mu_delegate` with `workspace: true` hit this
  when a label repeated. The leftover dir is untouched; the spawn takes
  the next name.
- **Parallel `mu` calls on a fresh DB no longer drop one.** The first
  fan-out into a new DB (a new machine or `MU_DB_PATH`) could lose a
  process two ways. Switching the file to WAL returns SQLITE_BUSY
  without honouring `busy_timeout`, so a loser exited `db locked`; it is
  now retried for up to 5 s. A process reading the schema version while
  another created the tables could see a half-built DB and refuse it as
  v1 (`SchemaTooOldError`); the version is now read in one transaction.

## [3.11.2] — 2026-10-10

**`mu_delegate` accepts model ids it used to refuse.**
Upgrade with `npm i -g @mu-crew/mu@3.11.2`, then `/reload` in running
pi sessions to pick up the extension. No schema change.

### Changed

- **`mu_delegate` is forgiving about `model`.** It used to refuse any
  value outside `[A-Za-z0-9._:/@+-]`, so real ids such as
  `modelbridge/meta-openai/gpt-6.1-sol[1m]:high` were rejected, and
  that happened in 12 past sessions. It now trims whitespace, drops
  surrounding quotes or backticks and a pasted `--model ` / `--model=`
  prefix, and shell-quotes any other value inside `--command`, so pi
  decides whether the id exists. An empty `model` counts as unset. The
  only value still refused is one with whitespace inside it.

## [3.11.1] — 2026-10-10

**pi's footer shows delegate results that have not arrived yet.**
Upgrade with `npm i -g @mu-crew/mu@3.11.1`, then `/reload` in running
pi sessions to pick up the extension. No schema change.

### Added

- **`mu_delegate` footer counts results pending.** A delegate that
  finished while pi was mid-turn has its answer queued as a follow-up,
  and the footer used to drop it from the count, so it looked as if
  nothing was outstanding. The footer now reads `1 result pending` until
  the answer enters the conversation. Escape, which clears pi's
  follow-up queue, also clears the count.

## [3.11.0] — 2026-10-09

**The skill learns model tiers, and a review panel's fixes land.** A new
`recipes/models.md` says which model tier each role needs; a five-angle
review of the skill found 41 problems, and the confirmed ones are fixed.
`mu agent close` no longer deletes edits in a `cp -a` workspace, and
`mu agent send` to a dead pane says so.

Upgrade with `npm i -g @mu-crew/mu@3.11.0`, then `/reload` in running pi
sessions to pick up the skill. No schema change.

### Changed

- **Skill: one agent per ready task, not per track.** An umbrella puts
  every unit on one track, so "one agent per ready track" read literally
  ran a fan-out with one worker. The skill now says to spawn per ready
  task, and to chain tasks that share files with `block` so only one is
  ready at a time.
- **Skill: wording fixes.** `REFUTED` is the verdict that sends a brief
  back for rewrite (there was no `AMEND`); SKILL.md drops text that
  restates `--help` and the outside-pi spawn steps, uses VOCABULARY
  terms, and models, worker and brief recipes get checkable Done whens.
- **Skill: model tiers.** New `skills/mu/recipes/models.md` ranks models
  by position in a lab's lineup (frontier, strong, mid, cheap, local),
  says which roles need which tier, and keeps local models as a last
  resort. Checkers run at the tier of whoever wrote what they check, or
  higher, from another family. SKILL.md and ten recipes point at it in
  place of the `pi_mini`/`pi_big` keys. Skill-only: `/reload` in running
  pi sessions to pick it up.

### Fixed

- **Skill: review recipes keep blockers honest.** `UNVERIFIED` findings
  no longer contradict `--if-ready` (umbrella stays open);
  adversarial-review re-blocks downstream work on `review_x_2` after a
  rejection; findings Group blocks the umbrella on the fix before
  superseding; adversarial-review uses *finding* and scopes itself to
  commit-producing units; rules-audit splits delegate/workstream mode;
  tasks-or-calls defines delegate call for scratch and a satisfiable
  Done when.
- **Skill: drift-audit and recovery.** The drift-audit late-note query
  no longer hides an unrelated `CLOSE:` note that follows a close;
  recovery's Done when is per operation and reachable on the DRIFT path;
  its teardown/undo bullets keep only what `--help` lacks.
- **Skill: codemode driver.** The scratch script writes each note to a
  file and pipes it to `mu task note`, so answer text (e.g. a `MU_EOF`
  line) never runs as shell; the stale cap-refusal warning points to
  orchestrator-loop § Concurrency.
- **Skill: remote-workers recipe safety.** Poll only after the worker
  reports done (the poll closes the task); gate on a scratch checkout
  via a temporary ref, never `main`; `--after-runs` takes the send's
  `runs` unchanged; no blanket `pkill -f x2ssh`.
- **`mu agent close` no longer deletes `cp -a` workspaces silently.** A
  `none`-backend workspace can't prove it is clean, so close refuses
  (`WorkspacePreservedError`) unless `--discard-workspace`. SKILL.md and
  waves.md now give the safe `workspace free` path and the `refresh
  --from` fix for unpushed merges.
- **`model` examples with `:<level>` failed through a gateway
  provider.** pi reads the first segment as the provider, so
  `anthropic/…:high` died with "No API key". The models recipe, delegate
  guide and `mu_delegate` help now say to copy `<provider>/<model>` from
  `pi --list-models`; a test pins that `mu_delegate` accepts
  `provider/family/id:level`.
- **`mu agent send` to a dead pane no longer says "ctl: refused".** When
  the control socket is silent and the pane is gone (the CLI exited,
  e.g. no API key), ctl verbs now raise `AgentPaneDeadError` with next
  steps to read the log, close the row and respawn, not link/kick/ssh
  advice. A live pane whose socket refuses still raises
  `AgentCtlUnreachableError`.

## [3.10.2] — 2026-10-09

**The TUI exits on `q` again with sync on.** Upgrade with
`npm i -g @mu-crew/mu@3.10.2`. No schema or pi extension change.

### Fixed

- **`mu` hung after `q` when `MU_SYNC_DIR` was set.** The TUI stopped
  rendering but the process never exited: the 3.10.0 sync worker was
  unref'd before its `message` listener was attached, and attaching it
  re-refs the worker. It is now unref'd after its listeners.
- **The TUI's exit flush no longer waits for the segment lock.** After
  `q`, the flush could wait up to 2 s on a lock held by another mu
  process. The TUI (bare `mu`, `mu state --tui`) now tries the lock
  once; if it is busy, nothing is written and the ops stay in the DB
  for the next flush. The TUI's worker has already flushed every 10 s.
  Other verbs keep the 2 s wait. Exit is ~150-450 ms when the segment
  manifest is sealed. A mu older than 3.10.0 still running on this
  machine rewrites it unsealed, which makes every flush rescan the
  segment, so restart those processes.

## [3.10.1] — 2026-10-08

**`mu_delegate` can pick a model per call**, so a review panel can mix
models from pi without configuring `cli` keys first.

Upgrade with `npm i -g @mu-crew/mu@3.10.1`, then `/reload` in running pi
sessions: the pi extension changed (the new `model` parameter). No schema
change.


### Added

- **`mu_delegate` takes `model`.** The value is appended as
  `--model <value>` to the cli's resolved command (`$MU_<KEY>_COMMAND`,
  else the key) and spawned with `--command`, so a review panel can vary
  models from pi without configured `cli` keys. Values with shell
  characters are refused before anything spawns. herdr refuses a command
  override, so `model` works on tmux only. The `cli` description no
  longer names a `pi_fast` key that may not exist. Reported in
  docs/bugs/2026-10-08-review-panel-friction.md (#1).

### Changed

- Docs: SKILL.md names `mu agent list --json` as the exception to
  `{items, count}`; codemode-driver warns against template-literal
  briefs; `mu agent wait --after-runs` help says one N applies to every
  named agent.

## [3.10.0] — 2026-10-07

**A performance pass: common verbs are 5-14x faster on a large DB with
sync on, and the TUI no longer freezes every 10 s.** On a 69 MB DB with a
56 MB sync dir, `mu --version` drops from ~310 ms to ~60 ms,
`mu task list` from ~1.1 s to ~85 ms, and `mu state` / `mu agent list`
from ~1.2 s to ~0.2 s. The TUI chunk loads only for the TUI, sync flush
and ingest touch only new data, read verbs no longer take the DB write
lock, and the TUI sync pass runs in a worker thread.

Upgrade with `npm i -g @mu-crew/mu@3.10.0`, then `/reload` in running pi
sessions: the pi extension changed (`mu_delegate` starts in one mu call,
nudges run in parallel). No schema version change; the first open adds a
local `sync_fingerprints` table and an index on `ops`, and 3.9.0 still
opens the DB.


### Changed

- `mu state`, `mu agent list` and the `mu state --tui` refresh no longer
  rewrite every agent's pane title on each pass. mu now retitles a pane
  only when its title changed, which cuts tmux server load on hosts with
  many agent panes.
- `mu task list` (and the other task tables) render large workstreams
  much faster: 1901 tasks render in ~10 ms instead of ~1.5 s. Output is
  byte-identical to before, including titles with unclosed ANSI colour
  or zero-width characters.
- **Faster CLI startup.** `dist/cli.js` no longer loads ink, react and
  yoga for every verb: the TUI is a lazy chunk (748 -> 203 modules for
  `mu --version` and `mu task list`). The CLI enables Node's compile
  cache under `<state>/compile-cache`, and skips it when the directory
  is unavailable or unwritable (`NODE_DISABLE_COMPILE_CACHE=1` turns it
  off). The TUI runs React's production build unless `NODE_ENV` is set.
  execa now loads only at its call sites. On a 69 MB DB with a 56 MB
  sync dir, `mu --version` drops from ~310 ms to ~60 ms.
- **Sync flush is O(appended).** A verb with nothing new to sync no
  longer reads and re-hashes the whole own segment, skips the segment
  lock, and leaves the `.manifest` untouched; appends hash only the new
  bytes. A pending flush that cannot take the lock leaves its ops for the
  next invocation instead of appending unlocked after 15 s. On a 41 MB
  segment a no-op flush drops from ~850 ms to ~1 ms, and 16 parallel
  synced verbs from ~10 s to ~1.5 s. `mu task list -w <ws>` on that data
  drops from ~1.1 s to ~85 ms. Explicit `mu sync` still verifies every
  line.
- **Sync ingest is cheaper.** Apply compiles each SQL statement once per
  connection, so a 19k-op catch-up drops from ~17 s to ~1.2 s, and a
  long-lived synced `mu task wait` peaks at ~118 MB instead of ~390 MB.
- Ambient sync ingest skips peers it is caught up on: a peer is skipped
  only when its segment's size, exact mtime and manifest hash match what
  the last clean full read recorded, so any rewrite (even one with a
  backdated mtime) is still read and reported. It also still repairs
  deferred edges and notes after a process died between ingest and
  repair, or when an SDK caller applied them through `applyIncomingOp`:
  a marker in SQLite's `user_version`, set in the applying transaction,
  makes the next invocation run the repair. The skip's fingerprint is kept in a new
  machine-local `sync_fingerprints` table (created on first open, no
  schema bump), so `sync_peers.last_seen_at` stays an ISO timestamp.

### Fixed

- `mu state --tui` no longer freezes for up to ~0.8 s every 10 s while
  it syncs: the slow-tick sync pass runs in a worker thread
  (`dist/tui-sync-worker.js`) with its own DB connection.
- TUI drill popups (DAG, notes) no longer re-wrap their whole body on
  every refresh tick (swayward DAG tick 130-250 ms -> ~6 ms). The TUI
  shares one terminal resize listener, which removes the
  MaxListenersExceededWarning.
- Read verbs no longer take the DB write lock: `openDb` skips its schema
  DDL when the DB is current, so reads stop bumping
  `PRAGMA schema_version` and stop failing with "database is locked"
  behind a long writer. Ops lookups for task claims, `mu undo`,
  `mu log --group` and quiet workstreams use index seeks.
- `mu agent list` and `mu state` probe each pi control socket with one
  `status` connection under one 1 s deadline, so a hung pi adds at most
  ~1 s instead of 2 s. `mu state -w <ws>` with 11 live agents drops from
  ~1.2 s to ~0.22 s on the data above.
- Workspace staleness in `mu state` and the TUI no longer snapshots jj
  working copies, and git resolves the main ref once per repo.
- `mu_delegate` starts a delegate in one mu call: new
  `mu agent spawn --next-free` (take the next free name) and
  `--send <text>` (send the first prompt in the same call; `--json`
  reports `send.runs`). The keep-driving, close and refute nudges check
  in parallel behind one settle handler, and every nudge that fires is
  delivered (before, only the last one survived).

## [3.9.0] — 2026-10-05

**A repo-wide review: about 130 bugs and doc/code mismatches fixed.**
tmux calls now target exact session names, so a workstream never acts on
another workstream's session, and `mu workstream teardown --empty` no
longer kills live or unregistered sessions. The test suite's tmux sweep
no longer kills your sessions. Undo, sync ingest, `mu sql` capture and
`--confirm-rows`, and `mu rebuild --force` keep data intact; workspace
refresh records the new fork point, `mu workspace free --commit` keeps
git commits, and jj workspaces work across workstreams. The `mu-scratch`
session stays open after its last agent, and concurrent writers no
longer fail with `database is locked`.

Upgrade with `npm i -g @mu-crew/mu@3.9.0`, then `/reload` in running pi
sessions. The pi extension changed (`mu_delegate` queue drain, nudge
parsing). No schema change.

### Changed

- `mu workstream teardown --empty` no longer kills `mu-*` sessions
  that have no workstream row. With no row there is no evidence the
  session is idle (a pane running a `bash -c` loop reports `bash`), and
  a run against a throwaway `MU_DB_PATH` had killed a live crew's panes.
  The sweep now takes registered empty workstreams only, and names the
  skipped sessions so you can tear one down by name.
- The `scratch` tmux session now outlives its last agent, so the next
  delegate does not pay for creating it again. The first spawn into
  `scratch` creates `mu-scratch` with the placeholder `_mu` window that
  `mu workstream init` creates (and adds it when an existing
  `mu-scratch` lacks it). `mu workstream teardown --empty` no longer
  sweeps the idle `scratch` session; `mu workstream teardown scratch
  --yes` still removes it. On herdr, the `_mu` tab is now labelled, so
  re-running `mu workstream init` no longer adds a second one.
- `mu -w <ws> <verb> …` works. The root `-w` was variadic and swallowed
  the verb, so `mu -w ws task list` printed help and exited 0. It now
  takes one value per flag and hands it to the verb's own `-w`; a verb
  without `-w`, or `-w` on both sides, is a usage error (exit 2). This
  also stops `mu --workstream=other workstream teardown --yes` from
  tearing down the `$MU_SESSION` workstream: teardown and `mu state`
  ignored a root `-w` and fell back to the ambient one.
- `mu sql` refuses to change a natural-key column (`workstreams.name`,
  `tasks.workstream_id`, `tasks.local_id`, a note's task, an edge's
  endpoints). Such an UPDATE wrote no op, so the ops log, sync, undo,
  and `mu doctor` disagreed with the table. The cross-workstream-edge
  hint no longer prints a "move the blocker" UPDATE, and the recovery
  guide no longer renames a workstream with `mu sql`.
- `mu log --kind` refuses `workstream`, `task`, `edge`, and `note` (exit
  2). A log line under one of those kinds was synced and replayed as a
  real change, so `mu rebuild` and every peer's `mu sync` failed with
  "malformed task key".
- Numeric flags reject trailing text and non-finite values instead of
  keeping a numeric prefix: `-i 5.9abc`, `-e 1e999` (stored as Infinity,
  serialised as null), `mu log -n 2x`, `--since 1.9` and
  `mu undo -n 2x` are now usage errors (exit 2).
- **`mu undo -n` rejects a value that is not a positive integer** (exit 2). Before, `-n abc` failed with `datatype mismatch`, `-n 0` claimed the log was empty, `-n -1` listed every group, and `-n 1.5`, `-n 2x` and `-n 1e3` silently used 1, 2 and 1.
- **Typed `mu task add` input errors exit 2.** An invalid task id now exits 2 (usage, with `--help`), like an invalid workstream name. It used to exit 4. A title with no ASCII letter or digit (for example `日本語`) raises `TaskTitleSlugEmptyError` (exit 2) and says to pass the `<id>` positional. It used to be a generic exit 1.
- `mu task wait --timeout`, `--stuck-after` and `mu agent wait
  --timeout` take fractional seconds and reject suffixes. Before,
  `--timeout 0.5` parsed as 0 (wait forever, or stall detection off)
  and `--timeout 10m` as 10 seconds.
- **A bare `mu task close` on a closed task is a no-op.** Without `--as` it keeps the current substate. Before, re-closing a `wontfix`, `rejected` or `duplicate` task silently changed it to `done`. Pass `--as` to reclassify.
- `mu rebuild <file> --force` deletes an existing `<file>` (and its
  `-wal`/`-shm`) before replaying. It used to replay into it, keeping
  that DB's foreign workstreams and ops.
- `mu workspace refresh` on sl now fails when `sl rebase` fails for a
  reason other than a conflict (bad `--from` ref, unresolvable
  `trunk()`). Before, it reported success.
- A DB lock held past the 5 s busy timeout (`database is locked`) exits
  5, as the exit-code table says, instead of 1. The table in
  `docs/architecture/sdk.md` now lists exits 6 and 7.
- `mu doctor` exits 5 when a row FAILs (today: the DB inside
  `MU_SYNC_DIR`), after printing the report or the `--json` payload.
  It printed FAIL and exited 0. WARN rows still exit 0.
- `mu task wait` exits 6 only when the owner's agent row is gone (the
  reaper). A manual `mu task release` or `mu task delete` of a watched
  task no longer reports a dead pane, including when the owner lives in
  another workstream (`mu task claim --for <ws>/<agent>`).
- `mu agent wait` reports a dead pane and exits 6 even when another
  watched agent finished. Before, it printed "All N agent(s) finished"
  and exited 0. `--any` names the agent that finished.
- Two parallel `mu agent spawn` calls with the same name no longer let
  the loser delete the winner's agent row and orphan its pane. The name
  check is repeated inside the spawn lock, and the loser exits 4 with
  `AgentExistsError` instead of a raw `SqliteError`.
- `mu agent adopt` of a pane in another session now throws
  `PaneNotInSessionError` (exit 4). The old error read "agent pane %15
  is in workstream a different tmux session" and suggested a command
  that could not run.
- `mu link pi` no longer writes the shim through a symlinked
  `~/.pi/agent/extensions/mu.ts` into its target, such as a dev
  checkout. A live symlink there is refused (exit 4) unless you pass
  `--force`, which replaces the link and not its target.
- `mu agent remote-env --remote-sock` rejects `:` and `%`. ssh `-L`
  splits on `:` and expands `%` tokens, so the forward broke or pointed
  at a different socket.
- `mu task wait --json` no longer adds a `reachedAt` field to `all`. It
  held the emit time, not when each task reached the target.
- **`mu undo --yes` on an already-undone group says nothing changed.** It used to print `Undid …` with a redo hint naming a group that recorded no ops; `--json` now reports `undoGroupId: null`. The preview no longer lists deleting a row that is already gone.
- `mu workspace refresh` on a workspace already on its base now prints
  "already at <ref> — nothing to replay" and `--json` returns an empty
  `replayed`. Before, it listed every commit above the fork point as
  replayed although the rebase moved nothing.
- `mu agent send` reports bytes as UTF-8 bytes (`sent N bytes`,
  `--json` `sentBytes`, and the `agent.send` op). It used to report
  UTF-16 code units, which undercounts non-ASCII text.
- `scrollbackLines` in `mu agent read --json` and `mu agent show --json`
  is now the number of lines returned, counted the same way in both.
  `read` counted a final newline as an extra line, and `show` echoed the
  requested `-n`.
- `mu workstream teardown --empty --yes` and `mu task delete` no longer
  promise a snapshot or offer `mu undo --yes`, which only lists groups.
  `task delete --yes` prints `mu undo <group> --yes` for its own group
  (and `--json` carries `group`); the sweep points at
  `mu workstream list --torn-down`, one group per workstream.
- `mu db compact --yes` and `mu db forget --yes` now report the shrunk
  DB size. Before and after are measured as pages × page size, so the
  shrink shows even when another connection's open read keeps the WAL
  checkpoint from rewriting the file; mu then says the file shrinks on
  the next checkpoint, and `--json` carries `checkpointed: false`.
  Before, the printed size was the same before and after.
- **SDK: `MuxBackend.attachHint` / `attachCommands` may return a Promise.** herdr needs an async workspace lookup, so the interface allows `string | Promise<string>` (and the same for the command list). Await the result when you call them through `MuxBackend` or `activeMux()`. `tmuxBackend` still returns plain values, and a third-party backend with synchronous methods still satisfies the interface.
- **A Syncthing conflict copy keeps its own watermark.** It shared the
  original's line count, so ops that existed only in the copy were
  skipped silently. The SDK's new `PeerSegment.watermarkKey` and
  `PeerStatus.watermarkKey` fields are optional; without them, the
  watermark is keyed by `machineId`.
- The SDK (`src/index.ts`) now exports every typed error the CLI maps
  to an exit code, including `SchemaTooNewError`,
  `WorkstreamNotFoundError` and `TaskIdInvalidError`.

### Fixed

- **tmux: a workstream never acts on another workstream's session.** Session-level calls (`has-session`, `kill-session`, `list-windows`, `new-window`, `list-panes -s`) target `=mu-<name>:`, so they no longer fall back to tmux's prefix match. Before, `mu workstream teardown auth` with no `mu-auth` session killed `mu-auth-refactor`, and reconcile listed its panes. `mu agent spawn --tab <window>` splits the window it listed by id (`=mu-<name>:@N`), so a session that vanishes mid-spawn fails the spawn instead of adding the pane to `mu-<name>-…`'s window of the same name.
- The test suite's default-socket tmux sweep no longer kills your live
  `mu-*` workstream sessions when your DB lives under `MU_STATE_DIR` or
  `MU_DB_PATH`, or is missing, locked, corrupt or on a newer schema. It
  reads every DB path mu resolves and skips the sweep when it cannot
  read one.
- Concurrent `mu` processes no longer fail with `database is locked`
  when one closes an agent or task while others write. Every write
  transaction now takes the write lock at `BEGIN IMMEDIATE`, so
  `busy_timeout` waits for it. A deferred transaction that read and
  then wrote failed at once if another process committed in between.
- **`mu undo` no longer refuses after a `mu task note`.** A note touches its task's `updated_at`, and undo counted that as newer work, so undoing an earlier edit exited 4 unless you passed `--force`. A later write to `updated_at` alone is no longer a conflict.
- **`mu undo` restores a field the action wrote twice.** `mu task park` and `mu task close` write `updated_at` twice, and undo restored the intermediate value instead of the value from before the action.
- **Undoing a claim or release restores the owner too.** Before, undoing a claim left the task OPEN but still owned, so other workers could not claim it. Undoing a release left the task IN_PROGRESS with no owner. Undo now restores the owner from this machine's ops if that agent still exists. A task that arrived from a peer, or that a peer re-created after a delete, goes back to unowned.
- **`mu undo` no longer lists or plans a legacy `workstream.export` group.** Its prose payload made the preview crash with a JSON error, or, with no earlier op for the workstream, plan deleting it.
- **Sync ingest no longer wedges on a segment written by mu < 1.1.** A
  historical `workstream.export` line (prose payload) threw a JSON
  error that rolled back the whole segment on every invocation. Ingest
  now skips it, as flush and `mu sync --from` already did.
- **`mu sync --repair <short>` works when the peer has a conflict
  copy.** The short id matched both files and exited 4. A ref now names
  a machine, and repair resets every file of that machine.
- **A blank line in your own segment is now self-repaired.** The owner
  skipped it while peers halted on it, so peers stopped there forever.
- **A segment shorter than its manifest no longer suggests
  `--repair`,** which cannot clear it. The warning says to copy the
  file again.
- **A peer now deletes a note whose tombstone key shifted.** When a reprojection gave a note a new rowid, its tombstone carries the full row, but apply only looked for a put under the tombstone's key and skipped it, so rebuilds and peers kept a note the origin had deleted. Apply now reads the tombstone's own payload.
- `mu sql` writes share one undo group with the intent `sql.write`, so
  `mu undo` reverts a whole `mu sql` call and `mu log` prints prose
  instead of raw JSON. Before, each changed row was its own
  "(no intent)" group.
- `mu sql --confirm-rows` counts the same rows for one statement as for
  a script: rows removed by `ON DELETE CASCADE` are now counted on both
  paths. `UPDATE ... RETURNING` is accepted as a write. The SQL runs
  once: the count comes from the same execution that commits, so a
  nondeterministic `WHERE` can no longer commit a count other than N.
- `mu workspace refresh` now records the new fork point as the
  workspace's `parent_ref`. Before, the `behind` count never cleared,
  `mu workspace commits` listed main's commits as the worker's, and
  `mu agent close` refused to free a refreshed workspace that held
  nothing. A refresh onto an older base (origin/main behind a workspace
  forked from local main) keeps the old fork point instead of moving it
  back. A conflicted refresh leaves it unchanged; refresh again after
  resolving, as the conflict hint now says.
- `mu workspace free --commit` on a git workspace no longer loses the
  commits. The worktree's HEAD is detached, so removing it left the
  auto-commit, and any commit the agent made, on no branch for `git gc`
  to delete. mu now creates the branch `mu/<workstream>/<agent>-<sha>`
  when no branch, remote or tag already holds HEAD, and prints it.
- **jj workspaces: same-named agents, missing dirs, project root, empty `@`.** A jj workspace is now named `<workstream>/<agent>`, so `worker-1` in two workstreams on one repo no longer fails with "Workspace named 'worker-1' already exists". Creating a workspace forgets a same-named registration whose directory is gone, so a workspace freed after `rm -rf` can be recreated. The TUI's project-root launch focus now maps a jj workspace to the repo it came from (via `.jj/repo`) instead of mu's state dir. `mu workspace commits` and the clean-workspace auto-free on `mu agent close` no longer count jj's empty, undescribed working-copy commit as a commit.
- `mu workspace refresh --help` and the conflict hint no longer say a
  git or sl workspace is left mid-rebase to resolve. Those backends
  abort the rebase, so the hint now says to rebase by hand. jj keeps the
  rebase and its conflicts, and the hint says so.
- **`mu_delegate`: a failed start no longer strands the queue.** When a direct call failed to start (spawn error, control socket not ok) while another call sat queued behind it, the freed slot went unused and the queued call never started. Now any start, queued or direct, starts the next queued call once its slot is free.
- **Keep-driving and refute nudges parse claims the same way.** The keep-driving nudge now arms on `mu task claim <id> -f <w>` and `--for=<w>`, and reads the workstream from `<ws>/<id>` after a leading `--for`. Both nudges count `mu` only as a segment's command (after any `NAME=value` env assignments), so `grep mu agent send` and heredoc bodies do not count as dispatch. A `<<<` here-string or a `<<` shift inside `$(( ))` does not start a heredoc, so a later claim still counts; a `((` that closes as nested subshells (`((cd x && cat) <<EOF … )`) still does, and a `#` comment is skipped, so neither exposes a heredoc body as dispatch. A backslash-newline continuation no longer becomes a word, which made the task id `\n`.
- `mu task wait` follows a watched task's owner into its own workstream
  (`mu task claim --for <ws>/<agent>`). It reconciles that workstream,
  so the owner's dead pane exits 6, and it reads the owner's state there,
  so `--stuck-after` and `--on-stall exit` (exit 7) fire. The stall hints
  name the owner's workstream. Before, such a wait ran on to the exit 5
  timeout.
- `mu task wait --status OPEN` no longer reports a task deleted
  mid-wait as reached.
- **tmux: `mu agent send` to a dead pane fails at once** (non-pi agents and `--via mux`). It polled the full readiness budget (`MU_SEND_READINESS_MS`, 15s) before failing with "can't find pane" (or "no current target" when the server has zero sessions). A transient capture failure still waits.
- **tmux: a missing socket file means "no server".** On a fresh boot, a cleared `/tmp` or a new `TMUX_TMPDIR`, tmux reports "error connecting to … (No such file or directory)". `mu state`, `mu agent list` and teardown now treat it like "no server running" instead of exiting 5.
- **tmux: `mu agent read -n N` and `mu agent show -n N` print the last N lines.** They printed the visible screen plus N rows above it. Trailing blank rows below the cursor are dropped first, so the result matches herdr's `--lines N`.
- `mu agent spawn` of a pi agent whose control socket answered no longer
  rolls back on a `No such file or directory` or `command not found`
  line in the pane tail. A resumed `--session` shows such lines as old
  tool output. The scan still catches provider and auth errors, and
  `AgentSpawnStartupError` no longer suggests API-key fixes for an
  exec failure.
- **herdr: attach hints land on the workstream.** The `Next:` attach line (`mu workstream init`, `mu agent spawn`) and the TUI's `a` key ran `herdr session attach mu-<ws>`, which starts a new, empty herdr server named after the workspace label. They now focus the agent's tab or the workspace by id (`herdr tab focus w1:t2`), then open a client with `herdr` when run outside a herdr pane, and carry `--session <name>` when `MU_HERDR_SESSION` is set.
- **herdr: the first agent's tab carries its name.** herdr labels a new workspace's first tab "1", so attach to the first agent spawned in a workstream fell back to focusing the workspace and showed whichever tab was active. mu now renames that tab to the agent's window name (or `_mu` for `mu workstream init`), as it already does for every later tab. If that rename fails, mu closes the new workspace before reporting the error, so a failed spawn leaves no bare-shell `mu-<ws>` workspace behind.
- **herdr: `mu agent adopt w1:p2` adopts by pane id.** Only `%`-prefixed arguments were treated as pane ids, so a herdr id was looked up as a pane title and failed. The orphan hint in `mu agent list` now shows a real orphan's id instead of a hardcoded `%15`.
- **herdr: orphan panes are surfaced.** herdr panes reported an empty command, so `mu agent list` and `mu doctor` never listed a herdr pane running an agent without a registry row. The pane's command is now the agent kind herdr detected.
- **herdr: clearer errors.** A herdr failure with empty stderr shows stdout instead of "no output". A vanished pane in `mu agent kick` reads "herdr pane not found" with herdr remediation. A creation verb given a command no longer claims to be "not implemented yet (owned by task mux-herdr-spawn)".
- A DB refused with `SchemaTooOldError` or `SchemaTooNewError` is now
  really left untouched. mu used to switch it to WAL mode (rewriting
  the header and creating `-wal`/`-shm`) before checking the version.
- An empty or relative `XDG_STATE_HOME` is ignored, as the XDG spec
  says. It used to put the state dir at `./mu` relative to the cwd.
- `mu log --source system` now lists the ops `mu log` shows as
  `system` (captured with no actor). It used to print "(no log
  entries)". `-n/--lines` help now says that with `--since` it keeps
  the first N entries after the cursor, not the latest N.
- `mu sync` suggested `mu log --limit 20`, which exits 2. It now
  suggests `mu log -n 20`.
- `mu log` renders `task accept` as `→ OPEN` instead of the raw field
  name `substate`.
- `mu task list` sizes the status column by the rendered pair (e.g.
  `CLOSED/wontfix`), so rows no longer run past the terminal width.
- `mu task notes --since` compares timestamps as instants. A cutoff
  without milliseconds or with a UTC offset no longer hides notes.
- `mu task wait --help` no longer names an `--all` flag that does not
  exist. Waiting for every task is the default.
- **Auto-derived ids keep a word that ends exactly at the 40-character cap.** That word used to be dropped.
- **`mu task block` and `mu task reparent` find the blocker in the dependent's workstream.** When another workstream that sorts earlier had a task with the same id, both verbs bound to that one and failed with a cross-workstream error. They now look in the dependent's workstream first, as `mu task add -b` already did.
- A commander parse error after a leading root option
  (`mu --json task list --bogus`, `mu -w x task note …`) now shows the
  verb's usage and hints instead of the root `mu` help.
- `mu doctor`'s case-collision fix now ends with
  `mu workstream teardown <old-name> --yes`; without `--yes` it was a
  dry run.
- `mu doctor`'s `ops rows` counts the workstream's task, note and edge
  ops. It counted only the workstream's own row.
- Orphan workspace dir advice no longer says `mu workspace free`, which
  does nothing without a row. The doctor `ws-dirs` row, the TUI doctor
  drill and `WorkspacePathNotEmptyError` give the `mu workspace orphans`
  recipe: `git worktree remove --force` from the project root, else
  `rm -rf`.
- The doctor `db-copies` row names the `mu.db.pre-compact-*` /
  `pre-forget-*` backups mu writes, instead of calling them hand-made
  copies. The `schema` and `schema_version` advice no longer claims
  `openDb` migrates older DBs (it refuses them). The `exports` row says
  the export verb went in 1.1.0, not 1.0.
- The TUI doctor popup's murmur row matches the card on herdr (`agent
  state from herdr`) instead of warning that murmur is missing.
- The commit view (TUI `show`) clips a commit whose `show` output is
  over 200,000 bytes at the 100,000-character cap and marks it
  truncated. Before, it showed an error and no text. A command that
  floods stderr shows an error instead of an empty commit.
- TUI: an active `/` filter no longer pushes a popup past the pane, and
  long drill bodies no longer do either. Both used to overwrite the
  popup's title border and clip its bottom border and hint.
- TUI: a double-click on a popup row drills the row you clicked. It
  ignored the scroll position, so a scrolled list opened a row near the
  top, and All tasks was off by its three strip rows.
- TUI: Tracks, Commits and Activity log drills stay on the row you
  opened. A filtered Tracks drill opened the unfiltered list's track,
  and a new commit or log event switched an open drill to another row.
- TUI: the Tracks task-detail leaf stays on the task you opened. A task
  that changed status re-sorted the track's task list, and the open
  leaf switched to the task now at that position.
- TUI: `?` over a popup keeps its cursor, filter and drill. Closing help
  used to reopen the popup's first row.
- TUI: popup hints and the `?` overlay no longer advertise
  `Shift 0-9 switch`. Only one popup is open at a time.
- TUI: the Doctor card and the Agents card's control-socket glyph update
  on the slow tick. Doctor and agent `ctl` changes were dropped until an
  unrelated field changed.
- TUI: the Workspaces card and popup show commits behind main again.
  They always showed `—`.
- TUI: the `/` filter accepts pasted text and non-ASCII characters. Both
  were dropped.
- TUI: launch focus counts task, note and edge activity when it breaks a
  project-root tie. It counted only agent and workspace rows.
- **Correct hints.** `mu task tree --down` says "omit --down" (there is no `--no-down`). The "commit" hint on `mu task close` matches the workspace's VCS and includes untracked files (`git add -A && git commit -m`, `jj commit -m`, `sl commit --addremove -m`). Before, it was always `git commit -am`, which refuses when only untracked files are dirty. The dormant-workstream hint lists `OPEN,IN_PROGRESS` tasks to match its unclosed count. The invalid-workstream-name hint no longer suggests a name that fails the same check. The invalid-task-id hint no longer names a nonexistent `--id` flag, and the not-found hint no longer prints the same recipe twice.
- **README quick start runs as written.** `mu workstream init` does not
  attach you to `mu-<name>`, so the next verb failed with "workstream
  required". The quick start now exports `MU_SESSION`.
- **The migration recipe says it needs a git checkout.** The npm package
  ships neither `scripts/` nor `src/`; `docs/guide/upgrade.md`,
  `scripts/README.md`, and the `SchemaTooOldError` next step now say so.
- **The `drift-audit` recipe's check 3 no longer flags every closed
  task.** Its query counted the `CLOSE:` / `<SUBSTATE>:` note that
  `mu task close` writes right after the close op; it now skips them.
- **Docs match the code.** `mu_` is no reserved task-id prefix (skill
  guardrail removed). Task ids allow 64 chars and are unique per
  workstream; `--tab` names are not validated; no
  `<state-dir>/workstreams/` dir exists (`docs/reference/naming.md`).
  `docs/reference/env.md` lists `TMUX`, `TMUX_PANE`, `HERDR_PANE_ID` and
  `HERDR_WORKSPACE_ID`, and says `MU_TMUX_SOCKET` skips `~/.tmux.conf`.
  The DB partitions by `workstream_id` (no `session_id` column).
  `workstream destroy` is `workstream teardown`. The delegate outcome
  list includes `error`. VISION no longer claims the TUI runs no
  subprocesses.
- **The doc/CLI drift test checks more commands.** `mu` inside a path
  or a quoted brief no longer exempts a command, and `drift-audit.md`
  is checked (a test now fails if a recipe is left out).
- **Docs: herdr refuses command overrides.** `docs/guide/backends.md` and `docs/reference/env.md` said `MU_<CLI>_COMMAND` is ignored on herdr; spawn refuses it and `--command` with exit 2.

## [3.8.1] — 2026-10-05

**The mu skill loads again.** 3.8.0's skill description contained ": ",
which YAML reads as a nested mapping, so pi rejected the frontmatter
("Nested mappings are not allowed in compact mappings") and dropped the
mu skill. The description is now a folded block scalar with the same
text, and a test checks SKILL.md frontmatter the way it already checked
prompt templates.

Upgrade with `npm i -g @mu-crew/mu@3.8.1`, then restart pi or `/reload`.
No schema change.

## [3.8.0] — 2026-10-05

**Checks before you commit, and decisions that keep their evidence.**
The mu skill now leads with refuting a claim, plan or brief through a
fresh `mu_delegate` call before acting on it. `mu_delegate record`
writes the refuter's verdict onto the task it judged, and bare decisions
warn. `mu agent send --interrupt` redirects a busy pi now, `mu agent
wait --after-runs` waits from an exact baseline, and a new `drift-audit`
recipe finds what an orchestrator has let slip.

Upgrade with `npm i -g @mu-crew/mu@3.8.0`, then `/reload` in running pi
sessions (`/reload --via mux` for agents spawned before 3.3.0). The pi
extension gains the ctl op `interrupt`; older extensions fall back to
abort plus send. No schema change.

### Changed

- **`mu_delegate` `record`: a check's verdict lands on the task it judged.** `record: { task, workstream? }` checks the task exists before spawning, then writes the answer's last `VERDICT:` line and its `EVIDENCE:` lines onto that task as one note headed `REFUTER <label> (...)` (a no-verdict note on timeout, death, error or cancel). The follow-up says where it was recorded.
- **Warnings on bare finding decisions; decision notes stand alone.** `mu task accept` and `mu task close --as rejected|wontfix|duplicate` on a triage finding warn (stderr, `warnings` in `--json`; exit code unchanged) when the reason is under 40 characters and no `VERDICT:` or `REFUTER` note is recorded. REJECTED and SUPERSEDED notes add the title of each task id they name (file names like `fix.ts` are left alone). Evidence notes from accept, open, unpark, release and claim are attributed to the actor instead of `<orchestrator>`.
- **Prose-safe text input.** `mu task note <id> -`, `--text -`, `mu task add --note -` and `mu agent send <a> -` read the text from stdin verbatim, so prose goes in through a quoted heredoc (`- <<'EOF'`). A note that is only `-`, empty or whitespace warns instead of being stored silently. A "too many arguments" error on those verbs hints that an apostrophe ended a single-quoted string. The skill documents the variable form (`v=$(cat <<'EOF' … EOF)`) for `--why` and `--evidence`.
- **Skills: decisions keep their evidence.** Refuters record their VERDICT/EVIDENCE on the finding (`record`, or a hand-written `REFUTER` note) before anyone decides; `--evidence` and `--why` name the deciding check, not a tally; review rejections give a reason per gap; an orchestrator that closes a review itself writes the same FILES/COMMANDS/VERIFIED note and names the commit. Tournament judges keep `WINNER:` on the umbrella.
- **Skills: adversarial model choice.** Reviewers, refuters, judges and auditors use a model at least as capable as the worker, from another family where one exists, never a smaller or local one; the same model in a fresh context is the fallback. SKILL.md lists recognisable small-model signs and a probe to run before spawning a reviewer.
- **`mu agent send --interrupt` acts now.** For a busy pi it aborts the running tool, waits for pi to settle, then sends the text as a new run (new ctl op `interrupt`; older extensions fall back to abort plus send, never paste; exit 5 and nothing sent if pi doesn't settle). `--steer` no longer claims to interrupt: it lands after the current tool call. A send queued on a busy pi prints how long it has been busy and names `--interrupt`.
- **Refute briefs before dispatch.** The skill (SKILL.md, plan.md step 7, brief.md) says a brief that asserts a cause, fix approach, threshold or claim about existing code is refuted by a delegate before a worker gets it. The pi extension adds a refute nudge: `mu task claim <id> --for` on a task with no `REFUTER`, `VERDICT:` or `REFUTE-EXEMPT:` line gets one visible notice per prompt (`review_*` tasks exempt; `MU_NUDGE=0` turns it off). The nudge parsers now ignore shell separators inside quotes.
- **A broader mu skill description.** It now leads with check-before-commit: before acting on a claim, root cause, plan, fix or brief, have a `mu_delegate` call refute it. It also covers second looks at your own work, parallel read-only work, background helpers and crews, in 501 characters (was 714). The `mu_delegate` tool description gains the same check-a-claim clause.
- **A nested pi is not the agent.** A pi run inside a mu agent's pane (`pi -p`, a model probe) finds the agent's control socket already served and no longer gets the agent's close, refute or keep-driving nudges; its stderr line says "nested pi: mu agent features off". Before, the close nudge took over the `-p` run and printed a reply about the agent's task instead of the requested work. Close and refute nudges also skip a pi without UI (print and json modes). A pi without `MU_CTL_SOCK` (an orchestrator) keeps every nudge.
- **When to pass `record`.** SKILL.md Quick checks and the `mu_delegate` tool description say it outright: a check that judges a mu task lands its verdict on that task (`record` on `mu_delegate`, or a hand-written `REFUTER` note on the `scratch` spawn path); with no task, skip both.
- **The TUI no longer shows closed tasks as running.** The owner column shows the live state glyph only on IN_PROGRESS rows; closed and reopened tasks show the owner's name alone (ownership on closed tasks is kept for history).
- **Drift audit.** A new `drift-audit` recipe: a read-only delegate the orchestrator runs periodically to find drift: notes a running worker never saw, stale pinned inputs, notes on closed tasks, decisions with no evidence, silent tasks, promised work never filed, and unrefuted briefs. `mu agent send` now records a local `agent.send` event (mode, transport, how long the target was busy), and `mu task note` on another agent's running task says that agent won't see it and suggests `--steer` or `--interrupt`.

## [3.7.0] — 2026-10-04

**pi agents drop more pre-ctl workarounds.** `mu agent wait --after-runs`
gives an exact send→wait baseline, so a fast run no longer hangs the
wait. pi spawns skip a fixed 1.5 s sleep and roll back when pi dies
during the handshake. Teardown removes control sockets, the scratch idle
nudge reads live state, and `Next:` hints and error advice use the
control socket where it answers exactly.

Upgrade with `npm i -g @mu-crew/mu@3.7.0`, then `/reload` in running pi
sessions (`/reload --via mux` for agents spawned before 3.3.0). No schema
change. `mu agent wait --lines` is removed (it had no effect).

### Changed

- **`mu state -w scratch` nudges only helpers that are actually idle.** The "idle scratch agent(s)" nudge used `agents.updated_at`, which is written only at spawn, so every helper older than 5 min was flagged even while busy. It now uses the live `idle` flag (`needs_input` past `MU_IDLE_THRESHOLD_MS`); a helper whose state is `unknown` is no longer nudged.
- **Docs: remote pi workers.** The remote-workers auth-prompt trap now applies only to non-pi CLIs and `--via mux` (a pi agent behind a prompt reports `ctl: missing`, and send never pastes). getting-started's exit-7 row states the 5 s pi / 120 s threshold.
- **`mu workstream teardown` removes its agents' control socket files.** Teardown deletes agent rows by cascade and never unlinked their sockets, so ssh `-L` forward sockets and `sock/<ws>/` were left behind. Each agent's socket (including hashed `sock/h/` paths) is now unlinked before the rows go, and `sock/<ws>/` is removed only when empty.
- **A tmux pi spawn no longer waits a fixed 1.5 s.** The pane is checked on each ctl handshake tick, so a pi that dies during startup rolls back at once with `AgentDiedOnSpawnError` (with its scrollback) instead of leaving a dead agent row after a 30 s ctl timeout. Non-pi CLIs, herdr, and `MU_SPAWN_CTL_MS=0` keep the old liveness check.
- **`mu agent wait --after-runs <n>`: an exact send→wait baseline for pi.** `mu agent send --json` now reports pi's run count before the send (`runs`), and `mu agent wait --after-runs <n>` waits for the first run past it. A run that finishes before the wait starts no longer hangs to `--timeout`, and `--after-runs <runs-1>` on an idle pi returns the last run's `lastText` at once. `mu_delegate` and the scratch recipes use it. A plain ctl send no longer makes an extra status probe. Removed the dead `mu agent wait --lines` option.
- **Exact `Next:` hints for pi agents.** `mu agent send` suggests `mu agent wait --after-runs <runs> --json`; `mu agent wait` drops the redundant pane read when it returned `lastText`; a stall (warning or exit 7) leads with `mu agent wait <owner> --after-runs <runs-1> --json` before the pane read; an abort that reported idle drops "Read the pane". Hints for non-pi agents are unchanged.
- **ctl error advice.** A pi agent at its project trust prompt has no socket yet, so it shows `ctl missing`, not `needs_input`. The ctl-missing error and `mu doctor` now suggest answering `/trust` or respawning with `pi --approve`. An outdated-extension error suggests plain `mu agent send <a> '/reload'` when the extension serves op `command`, and `--via mux` only for older ones; `mu doctor --json` reports `reloadVia` per outdated agent. With the mu extension linked, the old-murmur doctor warning says it affects only non-pi CLIs.

## [3.6.2] — 2026-10-04

**A settled pi worker stalls a wait in seconds, not two minutes.** For a
pi owner read over its control socket, `mu task wait` now reports a
stall after 5 s instead of 120 s.

Upgrade with `npm i -g @mu-crew/mu@3.6.2`. No schema change.

### Changed

- **`mu task wait` flags a settled pi worker after 5 s, not 120 s.**
  For an owner read over its control socket, `--stuck-after` now
  defaults to 5 s. ctl's idle is exact, and it arrives only after the
  close nudge has run, so a pi worker that is idle and still owns the
  task has already declined to close it. Waiting two more minutes adds
  nothing. An idle owner with queued messages (`pending`) is not
  flagged. murmur, herdr, and broken-socket owners keep the 120 s
  default. An explicit `--stuck-after N` applies to every owner. The
  SDK gains `ctlStuckAfterMs` and `DEFAULT_CTL_STUCK_AFTER_MS`.

## [3.6.1] — 2026-10-04

**murmur's `error` state is read as waiting, not unknown.** murmur 1.2.0
marks a pi run whose last turn failed as `error`. mu read that token as an
unrecognised murmur state; it now maps to `needs_input`, like `done` and
`crashed`, so an errored worker shows as stopped and waiting on someone.

Upgrade with `npm i -g @mu-crew/mu@3.6.1`. No schema change.

## [3.6.0] — 2026-10-04

**Stalled workers surface by default; workers are told to close.**
A bare `mu task wait` now exits 7 when a worker has sat in `needs_input`
for two minutes (`--on-stall exit` and `--stuck-after 120` are the new
defaults), so an orchestrator that forgets the flag no longer polls
until `--timeout`. A mu-spawned pi worker that ends its turn still
owning an `IN_PROGRESS` task gets one reminder to close it or say why
not.

Upgrade with `npm i -g @mu-crew/mu@3.6.0`, then `/reload` in running pi
sessions (`/reload --via mux` for agents mu spawned before the
upgrade). No schema change. Scripts that run a bare `mu task wait` and
relied on it polling past a stall need `--on-stall warn`.

### Changed

- **`mu task wait` now exits 7 on a stalled worker by default.**
  `--on-stall exit` is the default; pass `--on-stall warn` for the old
  keep-polling behaviour. Orchestrators kept forgetting the flag and
  polled past a worker that needed them until `--timeout`. A script that
  runs a bare `mu task wait` now gets exit 7 where it used to keep
  waiting. The
  `--status OPEN|IN_PROGRESS` carve-out is unchanged, and the SDK's
  `waitForTasks` still defaults to `warn`.
- **`--stuck-after` defaults to 120 s, down from 300.** Workers are now
  reminded to close (below), so one still idle after two minutes needs
  the orchestrator. `MU_IDLE_THRESHOLD_MS` (the `idle` flag in
  `mu state` and the TUI) stays at 5 minutes.

### Added

- **Close nudge: a pi worker that stops while owning a task is told to
  close it.** In a mu-spawned pi (`$MU_AGENT_NAME` + `$MU_WORKSTREAM`,
  not `scratch`), the extension checks `mu task owned-by` when a turn
  completes. If the worker still owns an `IN_PROGRESS` task, it injects
  one `mu-close-task` message naming the task and its `mu task close`
  command, or asks for a one-line reason if blocked, and continues once.
  Fires at most once per prompt and logs `mu log --kind nudge`.
  `MU_NUDGE=0` turns it off, along with the keep-driving nudge.

## [3.5.0] — 2026-10-04

**Delegates that queue, report, and fail visibly; a slimmer mu.db.**
`mu_delegate` no longer refuses past its cap: 16 run and up to 64 wait
in a queue, pi's footer shows each call from the moment it is made
(`running, starting, queued, failed`), and an API error after pi's own
retries comes back named, with the pane kept, for the model to decide.
murmur now holds `done` while a parent's delegates are still out.
Teardowns stop writing every note twice, and `mu db compact` and
`mu db forget <workstream...>` reclaim existing history; `mu doctor`
names the largest workstreams worth forgetting. On one real DB this
took mu.db from 86 MB to 53 MB.

Upgrade with `npm i -g @mu-crew/mu@3.5.0`, then `/reload` in running pi
sessions (`/reload --via mux` for agents mu spawned before the
upgrade). No schema change. `mu db forget` cannot be undone: it backs
up beside the DB first, and that backup is the only way back.

### Added

- **`mu_delegate` reports outstanding delegates to murmur.** Each change
  to the running, starting and queued count is emitted on pi's event bus
  as `murmur:pending`. murmur shows the count on the parent's card,
  renders a parent that stopped to wait as `waiting`, and holds `done`
  until the last answer is delivered. With no murmur loaded, nothing is
  listening and nothing changes.

- **`mu db compact`** applies that to existing history: blanks redundant
  note tombstones, then VACUUMs. **`mu db forget <workstream...>`**
  deletes every op of named torn-down workstreams, **not undoable**; it
  refuses live or never-torn-down names. Both dry-run without `--yes`,
  back up beside the DB first (`mu.db.pre-<verb>-<time>`), and run the
  drift check after. On the same DB, forgetting three old workstreams
  and compacting took it from 83 MB to 42 MB. `mu doctor` shows a size
  hint naming the largest forgettable workstreams.

### Changed

- **Note tombstones are slim.** Deleting a note (a workstream
  teardown deletes all of them) writes `{}` when the log already holds
  the note's put, instead of a second copy of the note. Undo and sync
  read the put. On one real DB this was 8 MB of 86.
- **`mu_delegate` queues past the cap** instead of refusing. At
  `MU_DELEGATE_MAX` running, further calls return `Queued as queued-N`
  at once and start as slots free, up to four caps' worth (64 by
  default); past
  that the tool refuses. A queued call's answer names its handle
  (`delegate-q3 (queued as queued-1) finished`), `mu_delegate_cancel
  queued-N` drops it, and quitting or `/reload` names the calls that
  never started.
- **Delegate API errors are named.** A delegate whose run stops on an
  API error after pi's own retries (overloaded, connection, auth) now
  reports outcome `error` with `lastError` in `mu agent wait --json`,
  instead of `empty`. `mu_delegate` keeps its pane, quotes the error, and
  tells the model to re-issue or record the check as UNVERIFIED; the
  footer counts it as `N failed` until the pane is closed. The control
  socket's `wait` reply carries `lastError` (a running pi needs
  `/reload` to serve it).
- **pi footer** shows each call the moment it is made:
  `2 delegates running, 1 starting, 4 queued, 1 failed`, instead of
  nothing until the pane was up.
- `orchestrator-loop § Concurrency` and the delegate guide note that
  answers arrive only when the agent stops, and that pi's
  `followUpMode: "all"` batches them into one turn.

## [3.4.0] — 2026-10-03

**Findings live in the graph.** A review's findings are now tasks in a
new `OPEN/triage` substate: in the DAG, blocking the review, but out of
`next` and `claim` until someone runs `mu task accept` or closes them
rejected or duplicate. Checks around them (refuters, claim checkers,
judges) are delegate calls whose verdicts land on the finding, so one PR
review no longer adds a task per check. Reviews nobody will track run as
`scratch` delegates. `mu_delegate` is capped at 16 in flight
(`MU_DELEGATE_MAX`), and `mu workstream init` and `mu state` hint at
`<project>-<purpose>` workstream names, one per effort.

Upgrade with `npm i -g @mu-crew/mu@3.4.0`, then `/reload` in running pi
sessions. No schema change: existing DBs gain the substate on open.

### Added

- **`OPEN/triage` substate** for proposed tasks, usually review
  findings. `mu task add --triage` creates one; it stays out of `ready`
  and `next`, `claim` refuses it without `--force`
  (`TaskInTriageError`, exit 4), and it still blocks its dependents, so
  a review cannot close with findings undecided. **`mu task accept <id>`**
  moves it to `OPEN/todo`; declining is `close --as rejected |
  duplicate --why`. `mu state` shows a Triage section (and `triage` in
  `--json`); `task next`, `task list`, `task show`, `claim` and
  `close --if-ready` point at accept and the triage inbox. No schema
  bump: one seeded substate row, per the substates spec (D10).
- **`MU_DELEGATE_MAX`** (default 16): `mu_delegate` refuses a new
  delegate when that many are already running from the session,
  counting parallel calls in one turn. The tool description states the
  cap.
- **Naming hints.** `mu workstream init <name>` prints a hint for a name
  without a `-`: workstreams are `<project>-<purpose>`, one per effort
  (`hint` in `--json`). `mu state` hints once a workstream passes 300
  tasks with fewer than 10% open. `docs/reference/naming.md` documents
  the convention.
- **`recipes/tasks-or-calls.md`** defines a **delegate call** (one
  `mu_delegate` call, or scratch spawn + `send --fresh` + `wait --json`
  without the tool; starts empty; fan out in one turn) and every recipe
  links to it. A refuter, claim checker, judge,
  skeptic, scout or synthesizer is a delegate call whose verdict lands
  on the task it judged, not a task of its own. `refute`,
  `review-panel`, `deep-research`, `tournament`, `rules-audit`,
  `hypothesis-panel`, `fan-out` and `ultrathink` follow it, so one PR
  review no longer adds a task per check. `orchestrator-loop` gains a
  Concurrency section (10 to 20 delegates, about one worker per core,
  ceiling written on the umbrella).
- **Commands** `/mu-debug <symptom>` (hypothesis-panel), `/mu-sweep
  <change>` (fan-out), and `/mu-until <stop rule>` (loop-until-done).
- **`recipes/findings.md`**: the rule every reviewing recipe follows.
  Findings are triage tasks in a workstream (more than 5 from one
  reviewer: note lines first, then a triage pass creates the tasks), or
  answer lines from delegates when nobody will track them (reviewing a
  PR or doc). `refute`, `review-panel`, `deep-research`, `rules-audit`,
  `hypothesis-panel` and `adversarial-review` now record findings,
  claims, violations, hypotheses and gaps as tasks; `review-panel` and
  `deep-research` default to delegates.

### Changed

- **Skill and recipe audit.** `recipes/triage.md` is now
  `recipes/backlog-triage.md`, so "triage" means only the substate.
  SKILL.md defines the recipe words (umbrella, unit, gate, wave,
  finding, verdict, stop rule). A rejected review now closes
  `--as rejected` instead of `done`, so it no longer unblocks downstream
  work; follow-up reviews wait on the gap tasks. Finding and verdict
  lines have one format, owned by `findings.md`. Every recipe has
  "Use when" and "Done when" lines and links the recipes it hands off
  to. `codemode-driver` covers delegate calls as well as workers. The
  README's "Ultrathink, the mu way" and the delegate guide describe
  when a review is delegates only and when it is tasks.

## [3.3.0] — 2026-10-03

**Ultrathink, the mu way.** The mu skill gains a recipe library for
long, multi-agent runs: fan-out, adversarial review, find-refute-
synthesize, hypothesis panels, tournaments, loop-until-done, triage,
deep research, review panels and rules audits, composed by
`recipes/ultrathink.md`. Every unit, review and round is a task in the
DAG, so the run stays visible in `mu state` and survives compaction.
In pi, `/ultrathink <job>` and the `/mu-*` commands start them, and a
one-shot keep-driving nudge stops orchestrators from ending a turn
while their workers are still running.

Upgrade with `npm i -g @mu-crew/mu@3.3.0`, then `/reload` in running pi
sessions (`/reload --via mux` for agents mu spawned before the upgrade).

**Not semver:** one change below breaks a CLI contract in a minor
release. `mu agent send <pi-agent> '/<cmd>'` for any slash command other
than `/new`, `/reload` and `/compact` now exits 2 instead of pasting it
into the pane. Add `--via mux` to keep the old behaviour. It is in 3.3.0
rather than 4.0.0 because only a script typing arbitrary slash commands
into a pi agent can notice, and the old paste could silently drop them.

### Added

- **Keep-driving nudge** in the pi extension. After a session dispatches
  mu work (`agent send`, `agent spawn`, `task claim --for`), if it ends
  its turn while that work is still IN_PROGRESS, the extension adds one
  visible `[mu-keep-driving]` message quoting SKILL.md's rule, with a
  `mu task wait` line for the running tasks, and continues once. A
  second stop stands. Each nudge is logged as `mu log --kind nudge`.
  `MU_NUDGE=0` turns it off; `mu doctor`'s `mu ext` row reports it.
  Spec: `docs/specs/2026-10-03-keep-driving-nudge.md`.

- **Recipe commands in pi.** The mu extension serves prompt templates
  from the package's `prompts/` through pi's `resources_discover`:
  `/ultrathink <job>`, `/mu-research`, `/mu-review`, `/mu-refute`,
  `/mu-tournament`, `/mu-rules-audit`. Each loads the matching recipe; they upgrade with
  mu. Running pi sessions need `/reload` once.
- **`recipes/deep-research.md`** (searchers by angle, one checker per
  sourced claim, cited report) and **`recipes/review-panel.md`** (one
  fresh reviewer per angle on a diff, findings refuted, then fixed or
  reported), and **`recipes/rules-audit.md`** (check mode: one checker
  per written rule plus a skeptic; mine mode: cluster repeated review
  corrections into proposed rules, refuted before a human decides).

- **`recipes/adversarial-review.md`**: a review is a task blocked by the
  work, run by a fresh agent (a different model recommended) against
  criteria written up front. REJECT grows the DAG with `fix_` and
  `review_..._2` tasks instead of rewriting history.
- **Workflow recipes** in `skills/mu/recipes/`: `fan-out`, `refute`
  (find → refute → synthesize), `hypothesis-panel`, `tournament`,
  `loop-until-done`, `triage`, and `codemode-driver` (a codemode script
  that dispatches through mu verbs and holds no state). **`ultrathink`**
  composes them: fix done, scout, pick a shape, plan every unit as a
  task, review every shipped unit, close against the stop rule. Every
  unit, check and round is a DAG task, so the run stays visible in
  `mu state`.
- **`recipes/brief.md`** (how to write a task note or prompt a worker
  with no context will read) and **`recipes/plan.md`** (spec to DAG:
  file map, sizing, `task_0`, INTERFACES, no placeholders, edges only
  for dependencies).

### Changed

- **Skill recipes.** Branch-only material in the mu skill moves to
  `skills/mu/recipes/`, loaded on demand through a recipe index in
  `SKILL.md`. `REMOTE_WORKERS.md` becomes `recipes/remote-workers.md`.
  New recipes `orchestrator-loop`, `worker`, `recovery`, `waves`,
  `long-run` and `watcher` take that material out of the core skill,
  which keeps one-line hard rules and shrinks from 295 to 210 lines.
  No CLI change.
- **Orchestrators keep driving.** SKILL.md states that an orchestrator
  ends its turn only when every task is closed or a human-only decision
  blocks progress; a status summary is a `mu log` line, not a stop.

- **pi agents never touch pane scraping.** `mu agent send <pi> '/new'`,
  `'/reload'` and `'/compact [instructions]'` run inside pi through a
  new control-socket op, `command`, instead of pasting into the pane.
  The reply carries pi's own answer, so `/compact` on a short session
  fails with `Nothing to compact (session too small)` instead of
  looking delivered. They refuse with exit 4 while pi is busy;
  `--force` overrides. `--json` adds `command`. A running pi needs
  `/reload --via mux` once to load the new op.
- **Breaking:** any other slash command sent to a pi agent exits 2
  (`AgentSlashCommandUnsupportedError`) instead of being pasted. Add
  `--via mux` to type it into the pane on purpose.

### Removed

- `MU_SPAWN_READINESS_MS` and the tmux spawn's wait for murmur to claim
  the new pane. pi agents have the control-socket handshake; nothing
  after a non-pi spawn needs murmur's first claim (state reads report
  `unknown` until then).
- The tmux paste path's `/new` screen-transition wait and its
  `transition-unconfirmed` send warning. Only pi's `/new` needed it,
  and pi's `/new` no longer pastes.

## [3.2.1] — 2026-10-02

**`mu_delegate` fixes.** Delegates start in the caller's working
directory, pi's footer shows how many are running, and cancel and
delivery no longer lose answers. Upgrade with `npm i -g
@mu-crew/mu@3.2.1`, then `/reload` in running pi sessions.

The docs are reorganised: `docs/USAGE_GUIDE.md` is split into a
tutorial and how-tos under `docs/guide/`, the pre-3.0 changelog moved
to `docs/history/`, and a link checker covers every markdown file.

### Fixed

- `mu_delegate` refuses a `cwd` that is not a directory. tmux and herdr
  silently start such a pane in `$HOME`.
- `mu_delegate_cancel` whose abort fails no longer drops the answer and
  leaves the footer count stuck: the delegate stays tracked, and an
  answer that landed meanwhile is delivered.
- `mu_delegate` refuses a `timeout` that is not a positive number
  instead of silently waiting an hour.
- A failure while delivering a delegate's answer is posted as a
  follow-up instead of an unhandled rejection.
- A failed send closes the delegate's idle pane and says so. Cancelling
  the tool call during spawn closes the new pane.

### Changed

- `mu_delegate` starts the delegate in the caller's working directory
  (new `cwd` parameter to override). Before, a scratch pane inherited
  the start dir of whichever spawn first created the `mu-scratch`
  session.
- `mu_delegate` shows the number of running delegates in pi's footer
  ("2 delegates running"), the same way `/goal` and `/loop` show their
  state. The entry clears when the last answer arrives or is cancelled.
- `mu_delegate` takes a `timeout` (seconds, default 3600) for how long
  to wait for the answer.
- With `workspace: true`, the tool result and the follow-up name the
  checkout path, so the caller knows where the edits are.
- `mu_delegate` takes a `label` that names the delegate
  (`label: "review"` → `delegate-review`), and the follow-up says how
  long it ran ("finished after 3m 05s").
- The `timeout` doc and the "still running" follow-up say the answer
  will not arrive later; the description says to end the turn when the
  next step needs the answer.
- The follow-up's `details` carry the answer, run time and workspace
  path, so automation can read them without parsing the text. The
  `workspace` doc says it isolates repository edits only: the delegate
  runs as you, with your files, environment and network.
- The tool description leads with "Subagent", so models reach for
  `mu_delegate` when a task calls for a subagent. Parameter docs say
  what `workspace`, `cli` and `brief` do, and that `brief` rules are
  not enforced.

## [3.2.0] — 2026-10-02

**pi agents are driven through a control socket.** `mu link pi`
installs mu's pi extension. The extension serves a per-agent unix socket
(`MU_CTL_SOCK`) inside the agent's normal interactive pi, so send,
state, wait, and abort are exact. Remote agents work the same way over
an ssh `-L` forward (`mu agent remote-env`). murmur is now needed only
for non-pi CLIs. Install is `npm i -g @mu-crew/mu && mu link pi && mu doctor`.

### Upgrade

```sh
npm i -g @mu-crew/mu@3.2.0
mu link pi        # installs the extension and the skill
mu doctor         # mu ext / mu skill / ctl rows should be ok
```

Then restart running pi agents, or type `/reload` in their panes, so
they load the extension. Until then, sends to them fail with
`ctl missing` instead of pasting into the pane. `--via mux` forces the
old paste path.

### Added

- **`mu link pi`** installs the extension as a re-export shim at
  `~/.pi/agent/extensions/mu.ts` (upgrading mu upgrades it; `--copy`
  pins a copy) and the skill as a symlink at `~/.agents/skills/mu`. A
  conflicting link needs `--force` (exit 4). `MU_PI_HOME` overrides the root.
- **Spawn sets `MU_CTL_SOCK` and handshakes** with a pi agent for up to
  `MU_SPAWN_CTL_MS` (default 30s). `--json` reports
  `ctl: ok|missing|refused|skipped`. No answer warns but exits 0.
  `--no-ctl` skips the handshake.
- **`mu agent send` to a pi agent goes through the socket**: `followUp`
  when busy, `--steer` to interrupt. An unreachable socket exits 1
  (`AgentCtlUnreachableError`) and pastes nothing. Text starting with
  `/`, non-pi CLIs, and `--via mux` use the paste path. `--json` gains
  `transport`. `mu agent adopt` probes the socket and prints the
  `MU_CTL_SOCK` to restart pi with.
- **`mu agent send --fresh '<prompt>'`** starts a new session and sends
  the prompt as one operation, for pi agents only. Use it instead of
  `/new` followed by a prompt, which could lose the prompt. A busy pi
  refuses (exit 4); `--force` abandons the running turn.
- **`mu agent abort <name>`** stops a pi agent's turn and returns once
  pi settles (`--timeout`, default 30s; exit 5 if still busy). A queued
  follow-up goes back into the editor unsent. Non-pi agents get exit 2;
  use `mu agent kick`.
- **The socket is the state source for pi agents** in `mu agent list`,
  `show`, `mu state`, `mu me`, and the TUI. A pi agent whose socket does
  not answer reads `unknown` (`ctl missing` or `ctl refused`), never a
  murmur fallback. For `mu task wait --stuck-after` / `--on-stall` it
  counts as needing attention (exit 7 under `--on-stall exit`).
- **`mu agent wait` is event-driven for pi agents** and returns the
  moment pi settles. Exit codes are unchanged (0 met, 5 timeout, 6
  socket lost). `--json` adds `outcome` (`done`, `empty`, `died`,
  `timeout`, `pending`) and `lastText`, the final assistant text
  (cut at 64 KiB).
- **`mu agent remote-env <name>`** prints the ssh args, identity env,
  and an example `--command` for a remote pi agent. It runs nothing.
  `ControlMaster=no` is required: with a shared ssh master the `-L`
  forward never binds. `--shell` prints eval-safe lines; `--remote-sock`
  overrides the remote path.
- **`mu_delegate { task, brief?, workspace?, cli?, keep? }`**: a pi tool
  for async one-shot work in pi sessions mu did not spawn. It spawns a
  `delegate-N` agent in `scratch` and returns at once. The answer arrives
  later as a follow-up message. Clean finishes close the pane unless
  `keep: true`. `mu_delegate_cancel` aborts and closes. `MU_DELEGATE=0`
  hides the tool.
- **`mu doctor` checks the extension, the skill, and every pi agent's
  socket** (`mu ext`, `mu skill`, and `ctl` rows). With the extension
  linked, a missing murmur is `ok`.
- **Extension version skew is reported.** A running pi keeps the
  extension it loaded at start. `--fresh` or `abort` against an older
  extension exits 4 (`AgentExtensionOutdatedError`) and suggests
  `mu agent send <name> '/reload' --via mux` or a respawn. The doctor
  `ctl` row flags old extensions and missing ops.
- **Next: hints show `--fresh` for a new task to a pi agent**, and
  `--steer` / `mu agent abort` when it is busy. Non-pi agents keep the
  old hints. Spawn hints include the attach command.
- Closing or reaping an agent deletes its local socket file.
- A `scratch` agent idle past `MU_IDLE_THRESHOLD_MS` gets the idle
  marker, so leftover delegate panes stay visible.

### Changed

- **murmur is optional for pi agents.** `mu link pi` replaces
  `npx skills add` for pi; other coding agents keep `npx skills add`.
- **One-shot work goes to a delegate** (`mu_delegate`, or
  `mu agent spawn -w scratch` + `send` + `wait --json`), a visible pane
  you can attach to, steer, or abort. The docs no longer point at
  pi-subagents.

### Fixed

- A pi agent spawned under a custom `--cli` key now stays a ctl agent
  for send, `--fresh`, abort, and state.
- A nested pi started inside an agent's pane no longer steals or
  deletes the agent's socket. `/reload` recovers an orphaned socket.
- Notes with repeated text now sync. Note identity now includes
  `created_at`. The first `mu` run after upgrading restores the missing
  notes from the ops log.

## [3.1.0] — 2026-09-30

### Added

- **`CLOSED/rejected`**: the proposal was declined
  (`mu task close --as rejected --why "..."`). `wontfix` now means only
  "valid, but not worth doing". The TUI `w` filter, now labelled
  "won't do", includes it.
- `scripts/migrate.ts` accepts a v11 source and re-derives a fresh v11
  DB from the ops log.

### Changed

- Legacy `REJECTED` history maps to `CLOSED/rejected`, not
  `CLOSED/wontfix`. Upgrading from 3.0.0: run
  `npx tsx scripts/migrate.ts --recover <db>` once, or migrate a copy.
  Recovery keeps a deliberate `close --as wontfix`.
- A 3.0.0 peer applies an incoming `rejected` as `CLOSED/done` until it
  upgrades.

## [3.0.0] — 2026-09-29

**Upgrading from 2.x:** stop every `mu` process, back up the DB, migrate
the backup with `scripts/migrate.ts`, verify, then swap. mu 3.0 refuses
a v10 DB until you do. The recipe is in `scripts/README.md` (removed).

### Breaking

- **Schema v11** adds `task_substates` and a non-null `tasks.substate`.
  A composite FK `(status, substate)` replaces the `tasks.status` CHECK.
  mu refuses a v10 DB (`SchemaTooOldError`, exit 4). Migrate a backup
  with `npx tsx scripts/migrate.ts <backup> --out <db>.v11`, then run
  `mu doctor --deep`.
- mu refuses a DB newer than it understands (`SchemaTooNewError`, exit 4).
- Task JSON gains `substate`. Edges in `mu task show --json` are
  `{ name, status, substate }`.

### Added

- **Task substates**: `OPEN/todo|parked`, `IN_PROGRESS/active`,
  `CLOSED/done|wontfix|duplicate|superseded`. Status alone decides edge
  satisfaction.
- `mu task close --as <substate> --why <text>`. `--why` is required
  unless `--as done` and is stored as a note. Any closed substate
  unblocks dependents.
- `mu task park <id> --why <text>` / `mu task unpark <id>`. A parked
  task leaves `ready` and `mu task next` but stays in `goals`. Park
  refuses `IN_PROGRESS` and `CLOSED` tasks. `mu task claim` needs
  `--force` for a parked task.
- `--substate` filter on `mu task list` and `mu task next`.
- TUI shows status/substate pairs. `p` / `w` toggle parked and
  closed-not-done rows.
- `scripts/migrate.ts` migrates v10 to v11. `--recover <db>` reruns
  legacy substate recovery in place, for example after `mu undo`
  restores a pre-v11 workstream.
- `mu task wait`, `mu task show`, `mu task next`, and `mu log` name the
  substate where it changes your next step.

### Changed

- Legacy `REJECTED` / `DEFERRED` history projects as `CLOSED/wontfix`
  and `OPEN/parked`. Ops payloads are unchanged.
- SDK: `normalizeTaskStatus` is removed. Use `mapLegacyStatus` /
  `resolvePair`.
