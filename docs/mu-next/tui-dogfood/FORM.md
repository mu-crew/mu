# TUI dogfood feedback

Fill this in as you go (edit the file, or paste it into the task note).
Run each scenario with `docs/mu-next/tui-dogfood/run.sh <N>` (see [README.md](README.md)).
Write `ok`, `bad: <what>` or `n/a` after each item; a screenshot or a pasted line beats prose.
Skip what bores you: a skipped scenario is a finding too (say why).

Terminal / size / tmux or not: ____________________  Date: __________

## First impression (before reading any hint)

- [ ] What did you think `mu` with no args would show, and did it?
- [ ] Time to find out how to quit: ______  how to switch tabs: ______
- [ ] Could you tell what each tab is for from its name alone?

## 1. Empty / first run  (`run.sh 1`)

- [ ] It says what is happening instead of looking broken (no workstreams, empty tabs).
- [ ] Every tab renders with no rows; no crash on `Enter`, `a`, `s`, `/`, `y`, `]`.
- [ ] Is it clear what to do next (is there any hint toward `mu workstream init`)? What would you want to see?

## 2. Small healthy crew  (`run.sh 2`)

- [ ] Tasks tab: order feels right (newest activity first)? Status text (`IN_PROGRESS`, `OPEN/parked`, `OPEN/triage`) and `@owner` readable?
- [ ] `s` cycles active / open / in_progress / closed / all; the closed `schema` task appears under `closed`.
- [ ] `/` filter: type `auth`, Enter keeps it, `c` clears. Does the filter line tell you what is active?
- [ ] DAG tab: can you see what blocks `release` and `api_v2`? Is the indentation / `+N open` / `again, listed above` understandable?
- [ ] Agents tab: state (`busy`, `needs_input`), the task it owns, the running tool and its elapsed time. Does `worker-3` showing `tool ?` (an old extension) read as "unknown" or as "broken"?
- [ ] `Enter` on a task shows its notes (brief, progress). `A` toggles all notes. `y` copies a usable command (paste it).
- [ ] `Enter` on an agent shows its scrollback. Scroll with `j/k`, `g/G`, space. Is the very long line handled? `r` reloads; `q` closes.
- [ ] `a` on an agent attaches to its tmux window; the line it prints and the Agents hint say how to detach (inside your own tmux: `Ctrl-b Ctrl-b d`), and that returns you to the dashboard intact (cursor, tab, filter kept).
- [ ] `[` / `]` switches to `shop-web`; Tasks and DAG follow it, Agents and Log stay machine-wide. Surprising?
- [ ] Log tab: readable? Does `Enter` on a line add anything?
- [ ] The `next:` line: useful, noise, or confusing?

## 3. Delegate wave  (`run.sh 3`)

- [ ] `]` to `scratch*`: can you find the delegates? Does a finished one show its verdict anywhere on screen? (On `hail-cache` tasks, `Enter` shows the verdict notes.)
- [ ] Can you tell running / queued / refused / failed / cancelled apart? If not, which do you want to see and where?
- [ ] Agents tab shows the 2 running delegates; their scrollback opens.
- [ ] Is the dashboard the right place for the wave tally (`mu delegates tally`), or is that a CLI job?

## 4. Trouble  (`run.sh 4`)

- [ ] Without being told, can you spot the dead worker (`worker-4`), the stalled one (`worker-2`, `bash 3h00m`) and the blocked one (`worker-3`)?
- [ ] State labels for them (`unknown`, `busy`, `needs_permiss…`): meaningful? Is the cut-off `needs_permiss…` acceptable?
- [ ] The human-needed task: easy to find? Does `Enter` show the reason in full?
- [ ] The malformed-CLOSE note on `webhooks`: found by opening the task? Should it surface on the Tasks row?
- [ ] `Enter` on the dead worker: what happens? What should happen?
- [ ] Would you trust this screen at 3 a.m. to tell you whether to intervene? What is missing?

## 5. Big  (`run.sh 5`)

- [ ] Scrolling: `PgDn`, `G`, `g` on Tasks (about 190 rows) and DAG (about 210). Any lag, flicker, lost cursor?
- [ ] Long titles are cut with `…`, never wrapped or corrupting neighbours. The CJK/emoji row and the ANSI/tab row (`t003`, `t005`) keep the columns aligned.
- [ ] The 64-char id is cut in the Tasks id column; is the full id visible anywhere?
- [ ] Workstream picker line (top): scrolls to the selected one; the `…` lead is understandable. Try `[` and `]` through all five.
- [ ] `Enter` on `t001` (60 notes) and `t002` (5 KB note), `t004` (multi-line): scroll and `A` (all) behave.
- [ ] Resize the terminal while it runs (narrow to about 60 columns, short to about 8 rows). Does it degrade without breaking?
- [ ] Agents tab: 10 agents, mixed states; `/` filter `stalled` or `worker-1` works.
- [ ] Is anything slow? (Subjective: instant / fine / sluggish.)

## 6. Live  (`run.sh 6`)

Leave it open on the Agents tab for two minutes.

- [ ] State and tool columns update without you pressing anything, with no flicker or flashing.
- [ ] The cursor stays on the row you chose when rows reorder or new ones appear (try on Tasks: new tasks arrive every few seconds).
- [ ] Order by activity on Tasks makes sense while it changes; is the movement distracting?
- [ ] `r` forces a refresh. Is there any sign of "loading…" or staleness that bothered you?
- [ ] On the Log tab, new lines follow the tail until you move up; they stop following after that.
- [ ] Open `Enter` scrollback on a worker and leave it for 20 s: does it update? (It should not; is that surprising?)
- [ ] Idle CPU: does your fan spin up? (`top` in another terminal.)

## 7. Remote (simulated)  (`run.sh 7`)

- [ ] Can you tell `worker-1` is remote? (`worker-1@dev` is remote; `worker-2` has no marker: local.)
- [ ] Its state and tool come through the forwarded socket like the local one's.
- [ ] `Enter` scrollback and `a` attach work for the remote one.

## Across scenarios

- [ ] Mouse: does clicking or scrolling do anything? Did you expect it to?
- [ ] Colours: readable on your theme? Is anything only distinguishable by colour?
- [ ] Help: is the bottom hint line enough, or do you want a `?` help screen?
- [ ] Quitting: `q` and `Esc` both leave; did either surprise you (Esc inside a filter vs. quit)?
- [ ] Anything that wrote to your terminal after quitting (garbage, lost scrollback, a stuck cursor)?

## Open questions

1. What was most confusing?
2. What is missing that you reached for?
3. What would you remove?
4. What would you do differently in the top three lines (workstream row, tabs, filter)?
5. Would you leave this open all day next to your orchestrator? What would stop you?
6. Any key that did not do what you expected?

## Findings (the triager fills this after you answer)

| # | Scenario | Finding | P1 / P2 / P3 | Task |
|---|---|---|---|---|
| | | | | |
