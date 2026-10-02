# How to use the TUI dashboard

The dashboard is read-only. To change anything, press `y` on a row to
copy its `mu` command, then run it in your shell.

## Open it

```bash
mu                        # every workstream, as tabs
mu state --tui -w a,b     # only these workstreams
MU_NO_TUI=1 mu            # print help instead
```

Bare `mu` opens the dashboard only when stdout is a terminal. Scripts
get help text. For a static card or JSON, use `mu state` and
`mu state --json`. Quit with `q` or `Ctrl-C`.

The first active tab is the first match of: `$MU_SESSION`, the current
`mu-<ws>` tmux session, a workspace that contains the current
directory, a project root that contains it, then the first tab.

## Read the cards

| Key | Card | Shows |
| --- | ---- | ----- |
| `0` | Commits | recent commits in the project root |
| `1` | Agents | agents with runtime state, CLI, and role |
| `2` | Tracks | parallel tracks of tasks |
| `3` | Ready | tasks with no open blockers |
| `4` | Activity log | recent ops as prose |
| `5` | Workspaces | per-agent workspaces, commits behind, dirty flag |
| `6` | In-progress | `IN_PROGRESS` tasks |
| `7` | Blocked | tasks with an open blocker |
| `8` | Recent | recently closed tasks |
| `9` | Doctor | quick health checks |
| `g` | DAG | the whole task graph (popup only) |
| `t` | All tasks | every task, sortable (popup only) |

A digit hides or shows its card. `Shift` plus the digit opens the
card as a popup. Only one popup is open at a time.

Cards reflow into 2, 3, or 4 columns at 120, 180, and 240 columns
wide. On a short terminal, low-priority cards drop out and the footer
says how many are hidden.

With two or more workstreams, a tab strip appears. `Tab` and
`Shift-Tab` switch tabs. A `*` marks `scratch`. A torn-down
workstream's tab stays, dimmed and struck through.

## Drill into rows

`Enter` opens the focused row. On a task it opens the task's notes.
`Esc` or `q` goes back one level.

- Tracks: track, then its tasks, then a task's notes.
- Workspaces: workspace, then its commits, then `git show`.
- Commits: commit, then the backend's show view.
- Activity log: the full text of the entry.
- Doctor: the remediation text for the check.

In a `git show` view, `t` opens `tuicr -r <sha>`. In the Commits popup,
`l` opens lazygit. In the Agents popup, `a` attaches to the agent's
pane. The dashboard comes back when the tool exits.

## Filter and sort

`/` filters the popup's rows by substring as you type. `Enter` keeps
the filter. `Esc` clears it.

In task popups, `o`, `i`, and `c` toggle `OPEN`, `IN_PROGRESS`, and
`CLOSED`. In the DAG and All-tasks popups, `p` toggles parked tasks and
`w` toggles tasks closed as anything but `done`. In All tasks, `b`
cycles the blocked filter and `s` cycles the sort: ROI, recency, age,
id.

## Keys

| Where | Keys | Action |
| ----- | ---- | ------ |
| dashboard | `+` or `=`, `-` | refresh faster (100 ms floor), slower (10 s ceiling) |
| dashboard | `r` or `F5` | refresh now |
| dashboard | `c` | clear the footer |
| any | `?` | help overlay |
| popup | `j` `k` | move |
| popup | `g` `G` | top, bottom |
| popup | `Ctrl-D` `Ctrl-U`, `PgDn` `PgUp` | half page, full page |
| popup | `y` | copy the row's `mu` command |

The mouse works for navigation only. Double-click a card to open it,
double-click a row to drill in, and scroll inside lists. There is no
mouse binding for back.

## Refresh

Task, track, and log data refreshes every second from SQLite. Agent
state, workspace dirty flags, commits, and doctor checks come from
subprocesses and refresh every 10 seconds. Switching tabs refreshes
the new tab at once.
