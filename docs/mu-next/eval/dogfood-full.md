# Dogfood full: a copy of swayward, moved and driven as the user will

Task `v_dogfood_full`. Checkout `be2cb00` + `npm run build` (`mu --version` 4.0.0-next.0), never installed. Host linuxpc, pi 1.4.0, tmux 3.7c, 2026-10-27 09:23 to 09:55. Orchestrator: sonnet-5-5 via modelbridge, pi TUI in a pane, the shipped `skills/mu` and `dist/extension/mu-pi.js` only.

## Setup

- `/var/tmp/m6/df/env.sh` unsets every `MU_*`, `PI_*`, `TMUX*`, `HERDR*`, then sets `MU_STATE_DIR`/`MU_DB_PATH` under `/var/tmp/m6/df/state`, `MU_SYNC_DIR=` (blank), `MU_TMUX_SOCKET=m6df`, `TMPDIR`, `XDG_*`, `PI_CODING_AGENT_DIR` (modelbridge only) and `MU_PI_COMMAND=piwrap.sh`. `bin/mu` runs `dist/cli.js`. `PATH` is that `bin` plus `/usr/bin`.
- Project: a `git clone --no-hardlinks` of `~/hacking/swayward-wm/swayward` (45 MB, no cargo). Three typed prompts: (1) 4 real swayward tasks as a crew, one on remote host `dev`; (2) after I "fixed" `dev`, run it there, plus a flake investigation whose worker sleeps 90 s; (3) close the human stop and record one slow delegate check. I killed worker-5's pane mid-task (09:41:51) and quit pi mid-wait with a delegate running (09:51:05), then ran `pi -c`.
- Remote host `dev`: a fake ssh (`fakessh.js`, as in `test/remote-spawn.integration.test.ts`) passing only `{env}`, forwarding the socket, with a "remote" `HOME` and `PATH` under `/var/tmp/m6/df/remote` and a separate repo clone. There was no reachable ssh host. Two harness gaps fixed mid-run (the remote `pi` lacked the mu extension, then the provider URL): realistic for a misconfigured host, and the orchestrator met both.

## Move (`skills/mu/recipes/move.md`) on a copy of the live DB

`sqlite3 -readonly ~/.local/state/mu/mu.db ".backup 3x.db"` (128 MB; `sha256sum -c` OK at the end), then a writable `old.db`. `swayward`: 57 open (12 parked), 0 IN_PROGRESS, 60 open-open edges.

| Step | Result |
| --- | --- |
| 3-4 `move.py` (dogfood-switch's, argv lists, dependents first) | 57 tasks, 60 edges, 12 parked, **0 failures, 11.5 s** |
| 5 verify | `mu db query … --all`: 45 todo + 12 parked; edge pairs **set-equal** (60/60); `mu task tree launch-beta1` renders 12 levels |
| 6 mark old | `MU_DB_PATH=old.db ~/.local/bin/mu task park --why "moved to mu-next"` × 57: 57 ok, 5.8 s |

## Worked

| Check | Result |
| --- | --- |
| Crew loop | 4 swayward commits cherry-picked onto `main` (`cb6cb6fb` dev-run, `7d49bff3` AGENTS.md, `7c6e9b2f` layout comment, `b62e2b7f` packaging). 5 local workers and 1 remote, all `agent spawn --task --worktree --send -`. At most 2 owned open tasks at once; 3 local panes were alive 09:30:36 to 09:33:19 (workers 1-2 idle, tasks CLOSED, kept until their reviews). 2 new triage tasks split off correctly |
| Reviews | 5 `mu_delegate` calls, 4 CONFIRMED and 1 REFUTED. The orchestrator overrode the REFUTED with evidence: the delegate read sway HEAD, the citation is right at the pin `88869399` |
| Remote | After the fix, `spawn --host dev --worktree --task` delivered, the worker settled with a commit 18 s after spawn, `close` kept the uncollected worktree, `collect` pinned `2d16055c`, it was cherry-picked, and the task closed from the CLOSE text. The pane env held exactly the 5 identity vars (`remote/last-env.json`) |
| Dead worker | Pane kill → reaper reverted the task to OPEN in the same second; `mu wait` returned `dead` exit 6; respawned as worker-6 (`--attempt retry2` after one refusal); note recorded 2.5 min later |
| Human-needed | `mu human-needed` + parked `human` task; the settle did not wait while it was open; prompt 3 closed it with `--evidence` |
| Restart/replay | pi quit with delegate-slow `running`; `pi -c` re-adopted it and recorded the verdict on the claim task 36 s after the restart. `mu rebuild` from 463 ops: tasks/notes/edges equal, state hash equal; `mu doctor --deep` drift ok (84 ms); `human_needs` is not rebuilt (documented) |
| No-client | `PATH` without tmux/herdr: `mu delegates register nc-1 --record …` + `mu delegates run nc-1`: done in 9.3 s, verdict note, report and close written |
| Dashboard | `timeout --foreground 60 mu -w swayward` in a pane: Tasks (56 rows), DAG and Agents tabs, `q` exits 0. Without `--foreground`, `timeout` puts the TUI in a background process group and it stops on SIGTTIN at "loading…" (harness trap, not mu) |
| Cost | Orchestrator 78 turns, 77 tool calls, $1.27 over 23 min |

## Findings

**F1 (P2): `mu wait -w <ws> --wave <label>` never sees the wave: the calls live in `scratch`.** The orchestrator followed `orchestrator-loop.md` ("`mu wait -w <ws> --wave <label>` returns its tally"). Every result had `"tally":{"summary":"0/0 CONFIRMED"}` while 2 answers had been recorded since 09:31:06. It then polled `task notes` with `sleep 40` (09:31:07 to 09:33:07) and again at 09:41:17. `--wave rev4` at 09:34:55 blocked 3 min on the other owned work, though its call had been `done` since 09:34:17. Cause: `callInScope` (src/wait.ts:228) keeps a call only if its workstream or record workstream is the scope; `mu_delegate` defaults to `scratch`. Clean repro (`/var/tmp/m6/wv`): with a done call in `scratch`, `mu wait -w wsa --wave rv` gives `nothing to wait for (no refs given and none owed to this caller)`, `-w scratch` gives the tally. A typo'd wave name gives the same message, never "no such wave". Task `triage_dff_wave_scope`.

**F2 (P2): failed remote spawns pile up `remote_recovery` records that block cleanup.** Four `--host dev` spawns that failed on `ctl refused` left records 3, 4, 9 and 10 for one path, though the rollback had removed the worktree (`aside` dirs gone). `mu agent close worker-3` then refuses (`4 removed agents of that name left a worktree … pass --recovery <id>`), and `--recovery 3` refuses (`newer recovery 10 owns …; deal with it first`). Clearing it took 8 calls, newest first, each a preview and `--if`, and 3 of them said `worktree already gone`. The orchestrator gave up and listed it as human work. Task `triage_dff_remote_recovery_pileup`.

## Isolation

- `~/.local/bin/mu` is unchanged: a symlink dated 2026-10-22. `~/.local/state/mu-next` and `~/mu-next`: nothing newer than T0 (`find -newer`). `tmux -L m6df kill-server`; no `/var/tmp/m6/df` process left.
- **The live `mu.db` mtime moved** (09:23:28 → 09:47:03), so "unchanged" does not hold, but none of it is mine. Its ops since T0 that mention swayward: 4, by `w-fprint`, the next-build orchestrator and `π - swayward-wm`. Ops containing `/var/tmp/m6`: 0. Live swayward tasks updated since 09:23: 0 (still 45 todo + 12 parked; my park ran on `old.db`).
- `~/mu` gained an empty segment `99681350…` (09:45:05). Its machine_id belongs to `/var/tmp/m4/state/mu/mu.db`, another worker's 3.x sandbox. Mine (`845e42be…`) is nowhere in `~/mu`.
- `~/.pi/agent/extension-state/fast-models.json` was touched: the harness's modelbridge `_lib.ts` writes under `homedir()` regardless of `PI_CODING_AGENT_DIR`. That is not mu. `~/.cache/mu` changes are another worker's `eval/surfaces`.

## P3 (one line each, on this task)

Listed in the close note of `v_dogfood_full`.
