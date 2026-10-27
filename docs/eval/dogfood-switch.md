# Dogfood at the switch: a real loop, the Move, the switch note

Task `v_dogfood_switch`. Isolated loop like [dogfood-4](dogfood-4.md) on `062210a` (both df4 triage fixes merged) + `npm run build`, never installed (`mu --version` 4.0.0-next.0). Host linuxpc, pi 1.4.0, tmux 3.7c, 2026-10-27 01:24 to 01:50. Orchestrator: sonnet-5-5 via a model gateway, TUI in a pane, the shipped `skills/mu` and `dist/extension/mu-pi.js` only.

## Setup

- `/var/tmp/d8/env.sh` unsets every `MU_*`, `PI_*`, `TMUX*`, `HERDR*`. It then sets `MU_STATE_DIR`, `MU_DB_PATH` (both under `/var/tmp/d8/state`), `MU_SYNC_DIR=` (blank), `MU_TMUX_SOCKET=d8`, `TMPDIR`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `PI_CODING_AGENT_DIR=/var/tmp/d8/pa` (the provider extension only) and `MU_PI_COMMAND=piwrap.sh`. `PATH` holds only `/var/tmp/d8/bin`, where `mu` runs the checkout. Every driver and Move call ran under `timeout`.
- Project: a throwaway git repo `textstats` (lib.js, `node --test`). Three typed user prompts, about 15 min of model time: (1) words, chars, README, plus "bump to 0.1.0 and publish: I decide"; (2) run batch 2 as a crew with tasks, 2 workers, a review wave before each merge and the release tracked in mu; (3) `paragraphs` (the worker sleeps 60 s first) plus one recorded claim check. I killed worker-4's pane mid-task (01:36:54).
- Isolation: `find ~/.local/state/mu-next ~/.cache/mu ~/mu ~/.pi -newer T0` found only my own pi session file (this worker's, not the AUT). The live `mu.db` mtime stayed 2026-10-26 21:09. `tmux -L d8 kill-server` left no `pi` or `mu wait` process.

## Worked

| Check | Result |
| --- | --- |
| Crew loop | 4 code tasks under umbrella `batch2` plus `paragraphs`, 5 workers (`agent spawn --task --worktree --send -`), never more than 2 alive. Every unit was cherry-picked onto main, 7/7 `node --test`, 8 commits |
| Review waves | 7 waves, 15 `mu_delegate` calls, all in `d8`. One REJECT (sentences: `3.14`) went back to the worker with `send --fresh`, was re-reviewed and approved. The model kept driving through batch 2 and never ended its turn mid-run |
| Dead worker | `mu wait agent:d8/worker-4…` returned `dead`, exit 6; the task was already back to OPEN with no owner and nothing committed. Respawned as worker-5 (`--attempt retry-1` after one refusal), done 90 s later |
| Human-needed | After prompt 2: `mu human-needed -w d8 "Release decision…"` plus parked `release_0_1_0`. `mu state` shows it under `human_needs`; the version was never bumped |
| Cost | 68 assistant turns, 72 tool calls, $0.73 for the orchestrator |

## Findings

**F1 (P1): in a named workstream the close nudge makes every delegate close its own task. The answer is lost and the verdict is garbled.** 15/15 delegates got `mu-close-task` ("You are stopping while you still own d8/delegate_…; close it now: mu task close … --evidence") and obeyed it. `finishDelegate` then found the task CLOSED (`isTerminal`) and wrote nothing. Results, on every call: no `report` note (only `brief,close`), `verdict` null, so every wave tallies "0/2 CONFIRMED … 2 UNVERIFIED". The settle says `Report unreadable here; read it: mu task notes …`, and that command shows only the delegate's one-line `--evidence`. On a recorded check the verdict written to the judged task is the text after the nudge: `NO VERDICT LINE: I closed task delegate_claim-readme_813acc22. The verdict stays REFUTED…`, not the delegate's real `VERDICT: claim_readme_documents_all REFUTED` line. Cause: `workerIdentity` (extension/nudge.ts) exempts only `scratch`, and mu-next's delegate spawn passes `--task <its delegate task>`. 3.13.3's delegate spawn passed no `--task` and owned nothing. Earlier dogfoods missed it: df3/df4 delegates ran in `scratch` (22/22 in df4's DB). It breaks "check before you commit" in every real workstream that names `workstream:`. Task `triage_dfs_delegate_self_close`.

**F2 (P2): `mu wait` hands back stale owned delegate events one per call, even on an explicit ref, and the model switched to `sleep` polls.** 5 waits returned `delegate … reached done` for a call whose answer the model had already read from its notes (the settle sent it there) and acted on. 3 of them were explicit-ref waits: `agent:d8/w1@1#…` (01:29:31), `agent:d8/worker-3@0#…` (01:31:41) and `task:d8/paragraphs` (01:37:39). This is by design ("never-returned events first", src/wait.ts), but the model reads it as noise. From 01:28:23 on it waited 7 times with `sleep 40..60; mu task notes …`, against the skill's "never `sleep` loops": about 6.4 min of the run spent in sleeps it chose itself. F1 is a partial cause (the settle sent it to the notes). One wait that returned every ready owned delegate event together, the way the settle's wave summary does, would take the reason away. Task `triage_dfs_wait_owned_drain`.

## The Move (`skills/mu/recipes/move.md`) on a 3.x copy

Copy: `sqlite3 ~/.local/state/mu/mu.db ".backup /var/tmp/d8/3x.db"` (127 MB, source mtime unchanged, `3x.db` sha256-checked before and after), then a writable `move/old.db`. Workstream: `next-build` (18 open, 2 of them IN_PROGRESS, 25 open-open edges). The mu-next side: a fresh `MU_STATE_DIR=/var/tmp/d8/move/next`.

| Step | Result |
| --- | --- |
| 1 read `-readonly`, own state dir | ok; `mu --version` 4.0.0-next.0 vs `~/.local/bin/mu` 3.13.3 (dogfood-1 F4 fixed) |
| 2 IN_PROGRESS | `<mu3> task release` × 2 on the copy: both OPEN/todo |
| 3–4 select + script | `move.py` (argv lists, dependents first, brief on stdin, last note capped 2 KB): 18 tasks, 25 edges, 0 parked, **0 failures, 3.8 s** |
| 5 verify | `mu db query … --all`: 18 OPEN, 25 edges, edge pairs **set-equal** to the selection; `mu task tree umbrella_post` renders 12 levels |
| 6 mark old | `MU_DB_PATH=old.db <mu3> task park --why "moved to mu-next"` × 18: 18 ok; the copy shows 18 OPEN/parked |

## The switch note (`docs/guide/upgrade.md`)

All as written: `MU_SYNC_DIR` holding a 3.x segment (one line copied out of `~/mu`) gives `MU_SYNC_DIR holds 3.x segments; give mu-next its own dir`, exit 4. With no state env the DB is `$XDG_STATE_HOME/mu-next/mu.db`. Rollback: `<mu3> task unpark t_skill` brings it back to todo. `mu pi migrate` on a copy of my real `~/.pi` shim + skill link: the report names both; `--apply` moved the shim to `disabled/mu.ts.shim` and left the skill link to the npm 3.x install alone ("not proven mu's"). That is right from a checkout; after `npm i -g` the link points into the install.

## P3 (one line each, on `v_docs_final`)

1. A respawn after a dead worker is refused: `attempt manual:paragraphs … already ran with a different request: pass --attempt <new key>`. The recovery recipe could say so.
2. One death gave two exit-6 events across consecutive waits (`dead agent:d8/worker-4`, then `dead task:d8/paragraphs`).
3. Move recipe: when the brief is the only note, the "last note" repeats it, and an IN_PROGRESS task's last note is often just `CLAIM: dispatch`. Say what to write instead.
4. upgrade.md "Old DBs" points to the design README (Move), while "Switch" links the recipe. Use one pointer: the recipe.
5. After prompt 1 the model did the work in its own pane (no tasks) and left the release decision as prose. The `human-needed` record only came when the prompt named mu tracking.
