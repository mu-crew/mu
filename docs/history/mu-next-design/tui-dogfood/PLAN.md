I've written the plan below. I checked it against the code on mu-next (92e3432) and 3.13.3. I captured renders through `tmux -L td` for scenarios 4, 5 and 7, plus 3.x at 200x50. I didn't capture 120x40 or 80x24 renders; those sizes are part of the verification in each unit.

# Dashboard TUI plan: dogfood feedback → work units

## What it looks like now (scenario 4, 200x50)
Every capture so far has used 13 of the 50 rows. Below that there are 37 blank rows. The `next:` line and the hint sit right under the list instead of at the bottom of the screen:
```
[payments]
 Tasks  DAG  Agents  Log
status: active   filter:    8 rows
> legal                         OPEN/parked  Terms wording for refunds
  human_needed_decide_the_fx_…  OPEN/parked  human needed: Decide the FX rounding policy: banker's rou…
  fx                            IN_PROGRESS  FX rounding policy  @worker-3
next: no authorised work
←/→ tab  [/] workstream  j/k move  Enter open ...
```
3.x at 200x50 puts three columns of cards with rounded frames on the same screen:
```
╭─ ¹ Agents ──────────────╮ ╭─ ³ Ready · 5 ─────────────────────╮ ╭─ ⁴ Activity log · last ↑8 ─────────╮
│ (no agents) try `mu ...  │ │ t6  OPEN  ROI 60  Task number 6…  — │ │ 13:34:38  system  task block  t1 … │
╭─ ² Tracks · 5 · 5 ready ─╮ ╭─ ⁶ In-progress ─╮ ╭─ ⁷ Blocked · 1 · top blocker: t1 ─╮ ╭─ ⁰ Commits ─╮
╭─ ⁹ Doctor · all healthy ─╮ ...                        (footer pinned at the bottom row)
```

## Root causes and fixes

**1. The viewport isn't filled.**
- Cause: `app.tsx` renders the rows from the top and stops. `layout()` only works out a row budget. The list isn't padded to `height`, the footer isn't pinned to the bottom, and nothing is framed.
- Fix: the screen is always exactly `rows` lines, with the footer on the last row.
- Add an **Overview** tab as the default first screen. It is a grid of framed cards for the selected workstream: Attention, Agents, In progress, Open (ordered by Next/ROI) and Log.
- The four existing tabs stay. They become full-height framed lists, with the tab name and count in the top border and `+N more` or `12/197` in the bottom border.
- 3.x geometry rules to port:
  - **Column count by width:** 1 column below 120, 2 at 120, 3 at 180 and above. Drop 4 columns.
  - **Row budgets:** each card has `min` and `max`. Spare rows go to the cards that still hide data, in proportion to what they hide.
  - **Fill:** a column with hidden data fills its height, and short lists aren't padded.
  - **Overflow:** shown as `+N more` in the bottom border.
- What to reuse from 3.x:
  - `titled-box.tsx` (245 lines): take the logic but trim it. Always pass a width, and drop the digit prefix.
  - `layout.ts` `dashboardColumnCount`, `columnWidths` and `allocateRowBudgets`: about 150 of its 732 lines. Rewrite them against a small `CardSpec{id,min,max,count}` instead of 3.x's `CardId`/`WorkstreamSnapshot`.
  - `wrap-ansi.ts`: **not needed.** mu-next never puts ANSI into `<Text>`, and `text.ts` `cell()` already cuts by visual width.
- Card placement: use a fixed table per column count. That keeps cards from jumping without 3.x's `arrangeColumns` hysteresis.

**2a. There is no sort option.**
- Cause: in `rows.ts` `taskRows`, the order is always the snapshot's newest-activity-first. In `app.tsx`, `s` cycles the status filter.
- Fix: give the Tasks tab and the Open card a 3.x-style cycle: activity (default) → roi → age → id.
  - roi = `impact/effort_days`, with ties broken by smaller effort.
  - age needs `created_at` added to `DashboardTask` in `src/dashboard-data.ts` (one SQL column).
- Keys: `s` becomes sort, as in 3.x. The status cycle moves to `o`. The worker may pick another letter, but should keep `s` for sort.
- The filter line shows `sort: roi ↓`.

**2b. Detaching after `a` attach in nested tmux.**
- 3.x (`tmux-attach.ts`) left the return trip to the user ("Ctrl-B p"). mu-next is already smarter: `src/mux/tmux.ts:580` uses `switch-client` when `inside`. But `commands.ts` `insideClient()` only checks whether `$TMUX` is set.
- What actually happens in the kit:
  - `run.sh` unsets `TMUX` and routes to a private `-L mudf-N` server.
  - So the TUI runs `attach-session` inside the human's own tmux, which nests: detaching needs `C-b C-b d`.
  - If `TMUX` were kept, `switch-client` against another server would fail.
- Fix:
  - `inside` = `$TMUX` is set **and** its socket path (the first comma field) equals mu's server socket.
  - Same server: `switch-client`. The hint reads `a attach (back: C-b L)`.
  - Different server, or `TMUX` unset while an outer tmux exists: `attach-session` with `TMUX` stripped from the child's environment, so it nests deliberately.
    - Option 1: add `env?: Record<string,string|null>` to `MuxCommand`.
    - Option 2: `spawnStep` strips `TMUX` when the plan says `nested`.
  - Before handing over, write one line to the suspended terminal: `attaching mu-x:worker-1 · detach: C-b d (nested: C-b C-b d)`. The Agents footer hint says the same.
  - Then `run.sh` can stop unsetting `TMUX`.

**4. Trouble is only visible on the Agents tab.**
- Cause: there is nothing global on the first screen.
- Also, `human_needs` is caller-scoped (`dashboard-data.ts:375`). It is empty for a human shell (`caller=null`), so the s4 human-needed shows up only as a task row.
- Fix: `loadDashboard` returns `attention[]`, which ignores the status and text filters and covers every workstream. Each item is `{key, workstream, kind, text}`, where kind is one of:
  - `dead`: the agent's state is `unknown` and its pane is gone (has a reason)
  - `permission`: `needs_permission`, with its `since`
  - `input`: `needs_input` for more than N minutes
  - `stalled`: tool elapsed over 15 minutes
  - `human`: an OPEN `kind=human` task, from any caller
  - `next unavailable`
  - sync warning
- UI:
  - A one-line strip under the tabs on every tab, e.g. `⚠ 4 need you: worker-4 dead · worker-3 permission 20m · worker-2 bash 3h · 1 human-needed (payments)`. It reads `✓ all quiet` when empty.
  - On the Overview, it becomes the Attention card. Enter on an item drills to that agent's scrollback or the task's notes.
- A malformed CLOSE is a P3: detecting it needs close-block parsing over notes, so skip it.

**5. BUG: the Agents and Log tabs ignore `[` `]`.**
- `src/cli/tui/rows.ts` `tabRows`:
  - `case "agents": return agentRows(snap, f, now)`
  - `case "log": return logRows(snap, f)`
  - Neither gets `ws`.
- `scopeKey()` also scopes those two tabs by tab alone.
- This was by design: `docs/mu-next/README.md` Dashboard table ("Agents: every workstream") and `test/dashboard-tabs.test.ts:240` (`// Log: every workstream`). The human overrules it.
- Fix:
  - Filter `a.workstream === ws` and `l.scope === ws || l.scope === null`.
  - `scopeKey` becomes per tab and workstream for every tab.
  - The log limit is 100 *global* ops (`DEFAULT_LOG_LIMIT`), so a quiet workstream on a busy machine would show almost nothing. Add a `logWorkstream` option to `loadDashboard` (log only; the snapshot stays global so Attention keeps seeing everything) and pass `ws` in the query.
  - Update the README table and the test.

**6. Column widths jump.**
- `logRows` doesn't pad at all (`${seq}  ${time}  ${scope}  ${rendered}`), so the scope column moves with every row and poll.
- `taskRows` and `agentRows` use `widest()` over the *filtered* list, so typing a filter or a live poll resizes the columns.
- The owner (`@worker-6`) comes after the title, so a long title clips it off (seen in s5 `t009`). The DAG rows aren't put into columns at all.
- Fix: port 3.x `columns.ts` `layoutColumns` + `renderRow` (about 80 of its 226 lines; swap its `truncate`/`visibleWidth` for `text.ts` `cell`/`string-width`). Protected columns are never cut; the one clip column (title or rendered text) is last and ends in `…`. Widths depend on the snapshot, not on the filter or scroll window:

  | Column | Width |
  |---|---|
  | id | widest over **all** tasks of the workstream, capped at 24 |
  | status | fixed at the longest status/substate label |
  | owner | before the title, widest agent name |
  | seq | number of digits of the max seq |
  | time | 8 |
  | scope | widest workstream name, capped at 20, then omitted once the log is per workstream |
  | agent | widest agent name; state fixed at 16 (`needs_permission`); host 6; tool 12 |

**7. Scenario 7 "everything remote".**
- The data is right: `agent list --json` gives `host:"dev"` for worker-1 and `null` for worker-2.
- The TUI never shows a host. Both agent rows and both panes look identical (same `busy` profile, same output), so the human couldn't tell them apart.
- Fix in the product: a `host` column on Agents (`dev` / `local`) and a host marker in the scrollback title.
- Fix in the kit (`scenarios.mjs`/`fake-worker.mjs`): print a banner in the pane (`remote:dev` / `local`) and use a different profile for worker-2. Update the FORM question.
- I couldn't reproduce "all remote" literally, so the worker should confirm with the human what they saw.

## Units (in order; recommendation in **bold**)

| # | Unit | Files | Lines | Depends on |
|---|---|---|---|---|
| U1 | Item 5: Agents/Log follow the workstream; `logWorkstream` | rows.ts, app.tsx (query), dashboard-data.ts, test/dashboard-tabs, docs/mu-next/README.md | ~40 | none |
| U2 | Geometry primitives: frame, columns, grid/row budgets | new tui/frame.tsx, tui/columns.ts, tui/grid.ts + unit tests | ~300 | none |
| U3 | Attention data (`attention[]`, `created_at`) | dashboard-data.ts, test/dashboard-data.test.ts | ~80 | none |
| U4 | Stable columns per tab, owner before title, host column, sort cycle | rows.ts, app.tsx (keys/filter line), test/dashboard-tabs | ~150 | U1, U2 |
| U5 | Attach: same-server `inside`, deliberate nesting, detach hint | commands.ts, mux/tmux.ts (+types env), app.tsx hint, test, kit run.sh | ~80 | none |
| U6 | Screen: Overview tab (default), framed full-height tabs, attention strip, pinned footer | app.tsx (layout section), new tui/overview.tsx, tests | ~250 | U2, U3, U4 |
| U7 | Kit: s7 pane banners and profiles, FORM/README, smoke checks for fill and stable columns | docs/history/mu-next-design/tui-dogfood/* | ~40 | U4 for the host column |

- **U1**: do it first. It's a small bug fix and it removes a wrong design claim.
- **U2**: port the logic, not the files. Keep these modules pure and plain-text so a unit test can pin them without Ink.
- **U3**: compute attention in the data layer, independent of filters, so every surface agrees.
- **U4**: base widths on the snapshot rather than the filter, and keep exactly one clip column, last. `s` is sort, as in 3.x.
- **U5**: fix `inside` in the backend, and always tell the user how to get back.
- **U6**: put the 3.x card grid on the first screen only. The tabs stay single lists, framed and filled.
- **U7**: make local vs remote visible in the panes, and turn the human's complaints into smoke assertions.

U1, U2, U3 and U5 can run in parallel. U1 and U4 both touch `rows.ts`, so run them one after the other (or give both to one worker). U4 and U6 both touch `app.tsx`, so U6 goes last.

## Verification (every unit; U6 and U7 gate)
- **Unit tests:** `npx vitest run test/dashboard-*.test.ts` plus the new unit tests for frame, columns and grid (row budgets at 30/40/50 rows, column counts at 100/120/180/240, protect/clip cases).
- **PTY snapshots:**
  - Run in a private `tmux -L td new-session -x W -y H`, with `MU_DOGFOOD_DIR=/var/tmp/td/df docs/history/mu-next-design/tui-dogfood/run.sh N`.
  - Capture with `capture-pane -p` at **200x50, 120x40 and 80x24** for scenarios 2, 4, 5 and 7.
  - Check that the last row is the hint and that there are no blank rows while any card shows `+N more`.
  - Check that s4 shows the attention strip on the first screen.
  - Check that the `]` key changes the Agents and Log rows.
  - In scenario 6, take two captures 5 s apart: the second column must start at the same x.
  - In scenario 7, the rows must show `dev` and `local`.
- **Kit smoke:** `python3 docs/history/mu-next-design/tui-dogfood/smoke.py`, with all 7 passing, plus the new fill and stable-column checks.
- **Attach:** in s2, run inside an outer tmux on another server. Check that the nested detach hint appears and that `C-b C-b d` returns to the TUI. With `MU_TMUX_SOCKET` unset on the same server, check that `switch-client` runs and `C-b L` returns.

## Not porting from 3.x
- `arrangeColumns` hysteresis and swaps, culling with `+N cards hidden`, the 4-column layout, hit regions and mouse support (`mouse.ts`).
- Digit card toggles, Shift+digit popups and superscript glyphs; `keymap-spec`, `help.tsx` and `status-bar.tsx`.
- `wrap-ansi` and ANSI in rows; `sync-worker`; the Commits, Workspaces, Tracks and Recent cards.
- tuicr and lazygit handoffs, and the Doctor checks themselves (Attention replaces that card).
- 3.x status toggles (`o`/`i`/`c`/`p`/`w`).

Budget: about 900 new lines on top of the TUI's current 1,373. That puts it near the mu-next ~2k-line target in `docs/mu-next/README.md`, so U6 should stay under 250 lines.

Scratch data is under `/var/tmp/td`. All the private tmux servers I used (`td`, `mudf-4/5/7`) are shut down.
