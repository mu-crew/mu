# TUI architecture

The TUI is a read-only, live-updating dashboard of 10 cards on `ink`.
It lives entirely under `src/cli/tui/`, the only place ink and react
are imported (a [ROADMAP](../ROADMAP.md#anti-feature-pledges) pledge).
CLI verbs stay the mutation API: the TUI yanks `mu` commands and the
operator runs them. Overview: [ARCHITECTURE.md](../ARCHITECTURE.md).
Press `?` in the TUI for the keymap.

## Entry points

- Bare `mu` launches the TUI when `process.stdout.isTTY` is true. It
  loads every workstream and picks the initial tab with the focus
  ladder in `src/cli/tui-launch-focus.ts`: `$MU_SESSION` → tmux session
  name → cwd inside a workspace → cwd equal to a workspace's project
  root (`src/project-root.ts`; latest activity breaks ties) → tab 0.
  With no workstreams it prints `mu --help` plus
  `Get started: mu workstream init <name>` and exits 0.
- On non-TTY stdout (pipes, CI, most agent calls) bare `mu` prints help.
  `MU_NO_TUI=1` forces that path inside a terminal.
- `mu state` is the static card; `mu state --tui` selects the TUI.
- The import stays dynamic (`await import("./cli/tui/index.js")`). A
  static import of ink anywhere else would pull the TUI graph into the
  help, version and `--json` paths.

## Cluster shape

| Files | Role |
| --- | --- |
| `index.ts`, `escapes.ts` | `runTui` entry; alt-screen and SGR mouse-mode lifecycle; pure escape bytes |
| `app.tsx` | `<App>` root: popup state machine, global keymap, tabs, footer |
| `state.ts` | `useDashboardSnapshot` poll loop (fast and slow tiers) |
| `keys.ts`, `keymap-spec.ts`, `help.tsx` | pure key dispatch; the keymap source of truth that drives both dispatch and the `?`/F1 overlay |
| `mouse.ts`, `use-popup-action-queue.ts` | vendored SGR mouse parser with double-click; one queued popup action per render |
| `layout.ts`, `columns.ts`, `wrap-ansi.ts`, `use-terminal-size.ts` | responsive columns and row budgets; aligned clipping; ANSI-aware wrapping; resize hook |
| `titled-box.tsx`, `popup-shell.tsx`, `list-row.tsx`, `padded-rows.tsx`, `status-bar.tsx`, `tab-strip*.ts(x)` | chrome primitives |
| `format-helpers.ts`, `agent-display.ts` | shared formatters and agent-row display |
| `use-popup-filter.tsx`, `use-status-filter.tsx`, `use-notes-drill.ts` | `/` filter; status (`o`/`i`/`c`) and substate (`p`/`w`) toggles; shared notes drill |
| `yank.ts`, `tuicr.ts`, `lazygit.ts`, `tmux-attach.ts` | clipboard; the alt-screen handoffs |
| `cards/*.tsx` | the 10 dashboard cards, plus `_placeholder.tsx` |
| `popups/*.tsx` | one fullscreen popup per card, plus `dag.tsx` (`g`), `all-tasks.tsx` (`t`), the `task-list-popup.tsx` scaffold, `drill.tsx`, `task-detail.tsx`, `cursor-row.tsx`, `scroll.ts`, `viewport.ts`, `show-loader.ts` |

## State machine

`<App>` owns:

- **Popup state:** `null` (dashboard) or one popup id. One popup at a
  time; `Esc` or `q` returns to the dashboard.
- **Card visibility:** toggled by `0`-`9`.
- **Tick rate:** fast tick, 1s default, adjusted with `+` `-` `=` `0`.
- **Active workstream tab:** `Tab` / `Shift-Tab` cycles when there are
  two or more. A torn-down workstream keeps its tab position and
  renders dimmed with strikethrough until the name is recreated. A
  torn-down single workstream shows its normally hidden tab.
- **Footer flash:** a transient status-bar message.

Popups own their local state (cursor, filter, drill mode, local modes
such as Workspaces' `list` / `commits` / `show`). They never mutate App
state. They receive a read-only props bag: `snapshot`, `db`,
`workstream`, `fastTickNonce`, `slowTickNonce`, `yank`, `onClose`,
`onModeChange`, `onFilterEditingChange`, `onFooter`.

## Polling tiers

| Tier | Interval | Loader | Reads | Cost |
| --- | --- | --- | --- | --- |
| fast | 1s, adjustable | `loadWorkstreamSnapshotFast` | SQL only: tasks, tracks, workspace rows, recent events, workspace orphans | p50 < 1ms |
| slow | 10s (`SLOW_TICK_MS`) | `loadWorkstreamSnapshotSlow` | subprocesses: agent liveness and state, workspace dirty status, recent commits, doctor summary | p50 hundreds of ms |

`mergeSnapshotFastSlow` merges the last slow result into every fast
render, so cards never flicker through loading. `r` / `F5` runs both
tiers now. A tab switch clears the slow cache and fetches eagerly.
`snapshotKey` returns the same `data` reference across no-op ticks, so
React's diffing short-circuits. The slow tick also runs ambient sync
([sync.md](sync.md#carve-outs)).

## Render geometry

`layout.ts`:

- **Columns by width:** stacked below 120 columns, then 2 at 120, 3 at
  180, 4 at 240. Stream cards (Commits, Activity log) trail; Commits
  trails last.
- **Row budgets:** each card has `min` / `max` / `chrome`. The allocator
  distributes rows so a noisy list cannot crowd its siblings. Overflow
  shows as `+N more · Shift+N` in the card's bottom border.
- **Culling:** when even minimum budgets do not fit, cards drop by
  priority (Doctor → Recent → Workspaces → …) and the screen shows
  `+N cards hidden · resize taller`.

`wrap-ansi.ts` wraps by visual width (`string-width`) and closes open
SGR state on every exit path, so a fragment without a trailing
`\x1b[0m` cannot bleed into ink chrome. Drill bodies are space-padded
to the exact box width, or ink's `wrap="truncate"` ANSI miscount eats
the right border.

## Read-only, with handoffs

Every popup row exposes one canonical `mu` command through `y`.
`yank.ts` probes pbcopy, wl-copy, xclip, xsel and clip.exe, then falls
back to OSC-52 over stderr.

The handoffs leave the alt screen, disable mouse mode, run a
foreground subprocess, and restore both on exit:

- `t` in any `git show` drill runs `tuicr -r <sha>` in the project root
  or workspace.
- `l` in the Commits popup runs lazygit.
- `a` in the Agents popup attaches to the agent's mux pane.

A TUI gesture that mutates state needs a ROADMAP entry first.

## Input

Mouse support uses SGR mouse mode. `mouse.ts` parses
`ESC[<button;x;y;M/m`, detects double-clicks, and exposes `useMouse()`.
A double-click on a card emits `setCursor` then `drill` through the
action queue, which consumes one action per render, so the cursor lands
before the drill reads the focused row.

`keys.ts` holds `dispatchGlobalKey` (dashboard), `dispatchPopupKey`
(popup), and `shouldSwallowGlobalKey` (keys a popup consumes).

## Drill recursion

List popups drill with `Enter`. `DrillScrollView`
(`popups/drill.tsx`) is the shared scrollable text leaf: Workspaces'
git show, Agents' scrollback, Activity log payloads, and Doctor
remediation. Task popups drill into `TaskDetailDrill`
(`popups/task-detail.tsx`, the notes timeline). Tracks chains track →
task list → `TaskDetailDrill`.

`useDrillKeymap` owns scroll state. An optional `resetKey` resets
scroll on identity change while a tick refresh keeps it, and
`onScrollChange` serves the DAG popup's focused-root tracking. Body
wrap metadata is shared so the scroll clamp and the painter cannot
disagree. Subprocess-backed drills use `popups/show-loader.ts`, which
keeps the prior body during a refetch.

## Test seam

See `test/README.md`. `test/_ink-render.ts` provides
`createInkInputStream`, `createInkCaptureStream`, `simulateInput` and
`latestRenderedFrame`: mount a popup or `<App>`, drive keys, assert on
the visible frame and spy callbacks. Source greps are for narrow
structural guards only, never behaviour.
