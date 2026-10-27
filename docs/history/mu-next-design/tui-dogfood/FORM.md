# TUI dogfood feedback, second pass

There is one section for each item of your first feedback (2026-10-27). The
original complaint is quoted, then what changed and how to try it. Answer the
three questions in each section; one word each is fine. Rebuild first:
`npm run build` in the checkout, then `docs/history/mu-next-design/tui-dogfood/run.sh <N>` (see
[README.md](README.md)). Item 3 (delegate wave) "worked", so it has no section.
Check that it still works under "Anything else".

Terminal / size / tmux or not: ____________________  Date: __________

## 1. Viewport and layout

> "The TUI does not fill the viewport; layout generally unappealing; take cues
> from the 3.x layout."

Changed: bare `mu` opens on a new **Overview** tab of framed cards (Attention,
Agents, In progress, Open by ROI, Log). It uses 1 column below 120 cols, 2 from
120 and 3 from 180. A card that hides rows grows and says `+N more` in its bottom
border. The other tabs are one frame that fills the screen. Next and the key
hint are pinned to the last two rows.

Try: `run.sh 5` (big) and `run.sh 2` (small) at your usual size, then resize
wide, narrow (about 80) and short (about 24 rows). A column of short cards
(little data) keeps blank rows under it. Only a card that hides data stretches.

- Fixed? ____
- Better than before? Closer to 3.x? ____
- What still bugs you (blank areas, frames, density, what the Overview shows)? ____

## 2. Sort, and getting back after `a` attach

> "Sort by missing. After `a` attach, how to detach? Nested tmux needs
> Ctrl-b b d: the TUI must say how, or attach must use switch-client."

Changed: on Tasks, `s` cycles the sort: activity ↓ → roi → age → id. The filter
line shows `sort: …`. The status filter moved to `o`. `a` (Agents tab) prints
`attaching … · detach: C-b d (nested: C-b C-b d)` before it hands over. The
Agents hint says the same. If the dashboard runs on mu's own tmux server, `a`
switches your client instead, and the hint says `back: C-b L`.

Try: `run.sh 5`, Tasks, press `s` a few times, then `o`. `run.sh 2`, Agents,
`a` on a worker, then come back the way the hint says.

- Fixed? ____
- Better? Is the sort order what you expected (roi = impact/effort; age = oldest first)? ____
- What still bugs you (keys, the detach line, landing back where you were)? ____

## 4. Trouble on the first screen

> "Works, but you have to go to the Agents tab to see it."

Changed: the Overview's first card is **Attention**, which covers every
workstream: dead, permission, waiting for input, stalled tool, human-needed,
`next` unavailable and sync warnings. j/k and Enter open the agent's scrollback
or the task's notes. Every other tab has a one-line strip under the tabs:
`⚠ 4 need you: …` or `✓ all quiet`.

Try: `run.sh 4`. Do you see worker-4 dead, worker-3 permission, worker-2's 3 h
`bash` and the human-needed task without pressing a key? Then `Enter` on each.

- Fixed? ____
- Better? Would you trust it at 3 a.m.? ____
- What still bugs you (missing kinds, wording, order, too loud or too quiet)? ____

## 5. Workstream switch

> "BUG: Agents and Log tabs do not change when cycling workstreams with [ ]."

Changed: every tab, the Overview included, shows the selected workstream. Each
workstream keeps its own cursor and filter. The Log is read per workstream, so a
quiet one does not come up empty.

Try: `run.sh 2`, press `]` and `[` on Agents, Log and Overview (`shop-web` has
one idle reviewer). `run.sh 5`: walk through all five workstreams.

- Fixed? ____
- Better? ____
- What still bugs you? ____

## 6. Column stability

> "Column widths not stable: widths jump 1 → 10 → 100 as content changes;
> long lines clipped badly."

Changed: the column widths come from the whole workstream, not from the rows on
screen, so a filter, a scroll or a poll cannot move a column. Tasks: id (cut at
24), status, owner, title. Agents: name, host, state, task, tool. Log: seq,
time, text. Only the last column is cut, and it ends in `…`. The owner now comes
before the title, so it is never cut off.

Try: `run.sh 6` (live). Watch Tasks and Log for a minute while tasks arrive.
Type `/` with a filter, then `c`. `run.sh 5`: the 64-char id, CJK and emoji, and
the 400-char title.

- Fixed? ____
- Better? ____
- What still bugs you (which column, which tab, what gets cut)? ____

## 7. Remote and local

> "Remote scenario shows everything as remote, not a mix of remote and local."

Changed: the Agents rows have a host column that says `dev` or `local`. In the
kit, each fake worker's pane starts with a banner and prefixes every line with
it (`remote:dev` or `local`). The two workers now behave differently too:
worker-1 is busy and worker-2 waits for input. Before, both ran the same
profile, so their rows and panes looked identical.

Try: `run.sh 7`. Agents tab, then `Enter` on each worker, then `a` on each.

- Fixed? Was "everything remote" the identical rows and panes, or something else? ____
- Better? ____
- What still bugs you? ____

## Anything else

- New problems this pass introduced (keys that moved, things that got slower, flicker)? ____
- Item 3, delegate wave (`run.sh 3`, `]` to `scratch*`): still fine? ____
- Would you leave this open all day next to your orchestrator now? What would stop you? ____

## Findings (the triager fills this after you answer)

| # | Item | Finding | P1 / P2 / P3 | Task |
|---|---|---|---|---|
| | | | | |
