# TUI dogfood kit

Try the new dashboard (`mu` with no arguments, `src/cli/tui`) on seven seeded
scenarios, then fill in [FORM.md](FORM.md) (second pass: one section per item of the
first feedback). Temporary: `release_cleanup`
moves or drops this directory. It ships nothing.

## Run

Build once, from the repo root:

```bash
npm install && npm run build
```

Then one command per scenario, in a real terminal (at least 100x30; the
bigger the better):

```bash
docs/mu-next/tui-dogfood/run.sh 1     # 1..7; `run.sh list` names them
```

Each run seeds a fresh isolated DB, opens the dashboard in your terminal,
and on quit removes the fake workers. Nothing touches your real mu state,
sync folder or tmux server:

- `MU_DB_PATH` and `MU_STATE_DIR` point under `/var/tmp/mu-dogfood/s<N>/`
  (override the root with `MU_DOGFOOD_DIR`); `MU_SYNC_DIR` is blank.
- Panes live on a private tmux socket, `-L mudf-<N>` (or `$MU_DOGFOOD_SOCKET`),
  never the default server. Look at them from a second terminal: `tmux -L mudf-<N> attach`.
- Every inherited `MU_*`, `PI_SESSION_ID` and `$TMUX_PANE` is dropped, so it works from
  inside tmux or a mu pane too. `$TMUX` stays: inside your own tmux, `a` opens a nested
  client on the private server and the hint says `detach: C-b C-b d`.

`run.sh <N> --keep` reuses the last seed instead of reseeding (the fake
workers are not respawned, so their rows show as dead). `run.sh clean`
deletes everything and kills the private tmux servers.

## The scenarios

| N | What you get | Where it opens |
|---|---|---|
| 1 | Empty first run: a brand-new DB, no workstreams | no workstream |
| 2 | Small healthy crew. `shop-api`: 9 tasks with blockers (a closed one, a parked one, a triage proposal, one authorised for `mu next`), 3 busy workers in real panes (one is an "old extension" that reports no tool). `shop-web`: an idle reviewer | `shop-api` |
| 3 | Delegate wave. `hail-cache` with 3 judged tasks; in `scratch`: delegate tasks that finished CONFIRMED / REFUTED / no-verdict / died / cancelled, 2 running with live panes, 1 queued, 1 refused | `hail-cache` (press `]` to go to `scratch*`) |
| 4 | Trouble. `payments`: a dead worker (pane gone), a stalled one (one `bash` for 3 h), one blocked on a confirm dialog, a human-needed task, a malformed-CLOSE note, closed-as-wontfix and duplicate tasks | `payments` |
| 5 | Big. `monorepo`: 200 tasks in a layered DAG, 10 agents (7 own a task), long titles, a 64-char id, wide CJK and emoji, ANSI and tabs in a title, a 400-char title, a task with 60 notes and one with a 5 KB note; 4 more workstreams with long names so the picker scrolls | `monorepo` |
| 6 | Live. 3 fake workers flip busy / idle / blocked / tool every 2-7 s; a mutator adds, claims, notes and closes tasks every 2-5 s | `live-demo` |
| 7 | Remote (simulated). `worker-1` runs through a fake "ssh" with a forwarded control socket, host `dev`, and stays busy; `worker-2` is local and waits for input. Each pane starts with a banner and prefixes its lines with `remote:dev` or `local` | `remote-demo` |

## What is real and what is fake

Real: the DB, the CLI, tmux panes on a private socket, the control-socket
protocol, `Enter` scrollback capture, `a` attach, `y` copy.

Fake: the workers are `fake-worker.mjs` (a node process that answers the
control socket like the mu pi extension and prints a transcript), not pi.
There are no LLM calls, nothing edits files, and the remote host is a local
process (`fake-ssh.mjs`). `Enter` scrollback shows its transcript; `a`
attach puts you in its real tmux window. The line printed before it, and the
Agents hint, say how to get back: `C-b d`, or `C-b C-b d` when the dashboard
runs inside your own tmux (a nested client).

## Keys to try (the dashboard's own hint line lists them too)

`←/→` or Tab: tabs (Overview first: Attention, Agents, In progress, Open, Log cards; then Tasks, DAG, Agents, Log) · `[` `]`: workstream · `j/k`,
Ctrl-d/Ctrl-u (half page), PgUp/PgDn, `g`/`gg` top, `G` bottom: move, in every list and drill · `Enter`: notes / scrollback / log entry · `a`
(Agents tab): attach, the hint says how to get back (`detach: C-b C-b d` nested, `back: C-b L` on mu's own server) · `s` (Tasks): cycle the sort (activity, roi, age, id) · `o` (Tasks): cycle the status filter · `/`: text filter
(Enter keeps, Esc cancels) · `c`: clear · `y`: copy the equivalent command ·
`r`: refresh · `q` or Esc: back out / quit.

## Smoke test the kit

```bash
python3 docs/mu-next/tui-dogfood/smoke.py              # everything, about 4 min
python3 docs/mu-next/tui-dogfood/smoke.py 4 6          # some scenarios only
python3 docs/mu-next/tui-dogfood/smoke.py fill stable drill  # the screen checks only
```

- **Scenarios** (through a PTY): each one must seed, render its workstream,
  take a few keys, quit on `q` with exit 0, and leave no private tmux server
  behind.
- **fill** (s2, s4, s5, s7 at 200x50, 120x40 and 80x24, every tab, read off
  a private tmux screen): the last row is the hint. A tab's frame reaches the
  last body row. An Overview column whose card says `+N more` reaches it too.
  A column of short cards may leave blank rows.
- **stable** (s6): on Tasks and Log, two screens 5 s apart; the second column
  starts at the same x on every row of both.
- **drill** (s2 at 120x40 and 80x24): Enter on a Tasks row and on a DAG row
  opens the task's notes, and the drill keeps the hint on the last row.

It does not judge whether the screens look good: that is what [FORM.md](FORM.md) is for.

## Files

| File | Role |
|---|---|
| `run.sh` | The launcher: isolation, private tmux, seed, run, clean up |
| `scenarios.mjs` | Seeds scenario N through the built SDK and CLI; `driver` is scenario 6's mutator |
| `fake-worker.mjs`, `fake-ssh.mjs` | The fake pi worker and the fake ssh |
| `smoke.py` | The smoke test: PTY runs, plus fill and stable-column checks |
| `FORM.md` | The feedback form |
