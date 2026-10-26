# Dogfood 1: isolated checkout, one Move, one pi orchestrator

Task `v_dogfood`, part A (the loop on merged surfaces; the full run is part B). Checkout at `1f19c8f` + build, run as `mun`, never installed. Host: linuxpc, 16 cores, node 24.22.1 (the node on PATH for `mun`), tmux 3.7c, 2026-10-26.

## Setup

- `mun` = `/tmp/dogfood1/bin/mun`, `exec node <checkout>/dist/cli.js "$@"`. Env: `MU_STATE_DIR=/tmp/dogfood1/state`, `MU_DB_PATH=/tmp/dogfood1/state/mu.db`, `MU_SYNC_DIR=` (blank), `MU_TMUX_SOCKET=mu-dogfood`, every other inherited `MU_*` and `PI_SESSION_ID` unset.
- Old DB: `sqlite3 -readonly ~/.local/state/mu/mu.db ".backup /tmp/dogfood1/old.db"` (schema v11, 123 MB). All reads of it use `-readonly`.
- Only workstream with a few hundred open tasks and a clean graph: `swayward` (57 open, 60 edges). `next-build` (56 open) is this crew's live one, `demo` has 1.
- tmux: `tmux -L mu-dogfood -f /dev/null start-server ; set -g history-limit 2000 ; set -g exit-empty off`. Peak 3 panes (spawn log: worker-3 at 08:16:03 while worker-1 was still up, see F9); `tmux -L mu-dogfood kill-server` at the end (`no server running` after).
- pi: `piwrap.sh` = `pi -ne -e modelbridge.ts -e <checkout>/dist/extension/mu-pi.js --no-skills --skill docs/mu-next/skill-draft --model modelbridge/anthropic/claude-sonnet-5-5`; `MU_PI_COMMAND` points workers at it. Both agents ran in a throwaway clone `/tmp/dogfood1/repo` (45 MB, no cargo).

## Isolation: before and after

Listings with timestamps: `ls -la --time-style=full-iso` of `~/.local/bin/mu`, `~/.local/state/mu`, `~/.local/state/mu-next`, `~/mu`, `~/.cache/mu` (jsonl and manifest lines elided; `~/mu` summarised by file count).

| Path | Before 08:07 | After the run | Cause |
| --- | --- | --- | --- |
| `~/.local/bin/mu` | symlink 2026-10-22 07:51 | same | not touched |
| `~/.local/state/mu` (3.x) | `mu.db`, `-wal`, `-shm`, `locks/` | `-wal`, `-shm`, `locks/` mtimes moved | crew's own live 3.x traffic (workers, the orchestrator, my `mu task note`/`add` calls) |
| `~/mu` | 34 files, live segment `1ec74dd7…jsonl` 61.4 MB | 34 files, same segment grew | same: live 3.x sync |
| `~/.cache/mu/delegate-answers` | 10342 | 10418 | a live 3.x delegate answer (08:40) |
| `~/.local/state/mu-next` | `compile-cache/`, `locks/` (mtime 08:06:32, before I started) | `locks/` mtime 08:40:50, still empty; `compile-cache/` entries 08:40:47 | **not attributed**: the dir was already being touched before my first command, by other checkout runs in this crew (F10); 10 later probes of `mun` with the isolated env left the mtime unchanged |

Verification that the isolated runs write nothing live: stat of the live segment, `~/.local/state/mu-next/locks`, 3.x `locks` and `mu.db-wal` before and after `mun task list/state/show` and the same with 3.13.3 on the copy: unchanged (no live writes). With every `MU_*` unset `mun` writes only to `~/.local/state/mu-next` (default), as designed. Nothing was written to `~/mu`, and `mun` never created `~/mu-next`.

The `mu-next` default dir is the only one whose mtime I cannot attribute: `locks/` was at 08:06:32 in the first listing, so something else (other workers running the checkout build with `MU_DB_PATH` but not `MU_STATE_DIR`, e.g. their test runs) writes there. After I set the isolated env, `mun task list/state/show/doctor/--version` left it unchanged (stat before/after, repeated). It is empty and inside the dir the pillars allow. The 3.x state, `~/mu`, `~/.cache/mu` and `~/.local/bin/mu` were not written by `mun` (their mtime moves match the live crew's traffic).

## Move (recipe `docs/mu-next/skill-draft/recipes/move.md`)

Followed literally on `swayward`; script `move.py` (python, argv lists, dependents first, brief on stdin).

| Step | Result |
| --- | --- |
| 1 read old DB `-readonly` | `mun` on the copy: `conflict: Detected v11 schema; v12 is required ... mu ships NO in-place migration` exit 4 (expected: a copy of a 3.x DB is not a mun DB; the recipe says never set `MU_DB_PATH` to it) |
| 2 select | 57 open tasks (45 todo, 12 parked), 60 edges with both ends open, 242 notes, 57 briefs |
| 3 add | `mun task add <id> -t -i -e --blocks <dependents> --note -` then `task note -m "moved from 3.x"`, `task park --why` for 12 parked: 0 failures, 9.3 s for ~126 calls (74 ms per call) |
| 4 verify | `mun sql "select count(*) from tasks"` 57 (all OPEN), parked 12, todo 45; edges: `mun sql ... --all` 60 pairs, **set-equal** to the selection. `mun task tree launch-beta1` renders the umbrella with 12 levels |
| 5 mark old | with 3.13.3 on a **copy** (`/tmp/dogfood1/old-for-park.db`): `mu task park <id> --why "moved to mu-next"` x57: 57 ok, 4.5 s; old side shows 57 parked. The live 3.x DB was not touched |

The recipe worked. Friction: F2 (only the first note moves), F3 (IN_PROGRESS tasks), F11 (default `sql` row cap hides edges), and one wrong first guess of mine: the first `move.py` ran `mun` where the recipe step 5 needs 3.13.3 (see F4).

Trial of the recipe on the old binary: `mu task add` in 3.13.3 has no `--blocks` and takes one id; the 3.x ordering is blockers first (`-b`). I used that only to build a 3.x-shaped DB (`small3x.db`) for the overhead comparison, not part of the recipe.

## Orchestrator run

Prompt: `orch-prompt.md` (swayward tasks `devrun-stray-proc-error`, `ci-proptest-cadence-truth`, `version-string-packaged-builds`; umbrella `dogfood-wave`; 2 workers at once; cherry-pick onto branch `dogfood`; list every misleading hint). Model sonnet-5-5 via modelbridge, skill draft loaded (4.2 KB `SKILL.md`), it read three recipes of its own accord.

| Outcome | Result |
| --- | --- |
| Tasks closed | 3/3 `CLOSED/done` by their workers with `--evidence`; umbrella `dogfood-wave` closed with `--if-ready` |
| Commits on `dogfood` | `b8f7f2a0` dev-run guard, `304551c2` AGENTS.md/ci.yml wording, `25ea9e9b` BUILD_COMMIT short sha (5 files, +9/-4) |
| mu calls (orchestrator) | 18 bash calls, 0 mu errors with exit != 0 apart from the two exit-6 waits (F1) |
| Turns / tokens (orchestrator) | 18 turns, 30.4k input, 6.0k output, 441k cache read; workers 4/4/6 turns, 2.1k-2.1k out |
| Wall clock | 08:15:45 to 08:16:35 = 50 s for 3 tasks |
| `mun wait`, CLOSE block, `mun next` | `mu wait` (typed refs) not used by the agent; it used `task wait --first --on-stall exit --json` as the skill says. CLOSE block not used: local workers closed with `mu task close --evidence`. `mun next` does not exist yet (F5) |

The workers read their brief and claim at spawn (log: `agent spawn`, `task claim`, `agent send` within the same second): the `agent spawn --task --send -` path works. Reaper cleared owners after close without trouble. `mu state` was 7.4 KB for a 57-task workstream (cap 4 KB is per field, first call printed `more=38 retrieve=mu state -w swayward --full`).

## Friction

Each is a triage task in `next-build`. Output tails are verbatim.

### F1 `df1_wait_stale_dead`: exit 6 for a worker closed on purpose

```
$ mu task wait ci-proptest-cadence-truth version-string-packaged-builds -w swayward --first --on-stall exit --json
{"ok":true,"data":{"firing":{"kind":"dead","ref":"agent:swayward/worker-1"},"event":{...},"exit":6,...,"reason":"agent swayward/worker-1 is gone (its pane died); the work is not done","open":1,"snapshots":[{"kind":"agent","ref":"agent:swayward/worker-1","status":null,"fired":false,"dead":true},{"kind":"task","ref":"task:swayward/version-string-packaged-builds","status":"IN_PROGRESS",...
$ mu agent close worker-2 -w swayward --if 176662545011039   # its task already CLOSED/done
$ mu task wait version-string-packaged-builds -w swayward --on-stall exit --json
{"ok":true,"data":{"firing":{"kind":"dead","ref":"agent:swayward/worker-2"},...,"exit":6,"reason":"agent swayward/worker-2 is gone (its pane died); the work is not done","open":0,...
```

The agent was never in the id list, and its task was CLOSED. The next wait gave the real event (`kind:closed`, exit 0). Highest-severity finding: a loop that obeys "6 = recover" would re-dispatch finished work.

### F2 `df1_move_drops_later_notes`: only the first note moves

`deploy-aur` last note: `PARKED: beta1 plan 2026-10-04: post-beta1 (member of post-beta1-list)`; `differential-campaign` (74 notes) last note: `PAUSED 2026-10-11 (disk cleanup) ... Restart as nightly net`. Recipe step 3 says "re-park --why what was parked" but step 2 never selects the why. My script wrote `parked in 3.x`.

### F3 `df1_move_in_progress`: no step for IN_PROGRESS

```
$ MU_DB_PATH=<copy> mu task park v_dogfood -w next-build --why "moved to mu-next"
conflict: cannot park v_dogfood: it is IN_PROGRESS (release it first)
```

next-build has 3 IN_PROGRESS tasks; swayward none, so the Move itself was unaffected.

### F4 `df1_version_string_same`: both binaries say 3.13.3

```
$ mun --version        # the checkout
3.13.3
$ mu --version         # installed
3.13.3
```

I put a `mu` wrapper first in PATH for pi and, later, ran Move step 5 with it: 57 calls, each `SchemaTooOldError` exit 4 (`Detected v11 schema; v12 is required`). The error was clear; the version gave no way to tell which binary ran.

### F5 `df1_unknown_verb_dumps_help`: unknown verb prints the whole help

```
$ mun next
error: too many arguments. Expected 0 arguments but got 1: next.
Usage: mu [options] [command]  ... (7,681 bytes)
$ mun task frobnicate        -> error: unknown command 'frobnicate'  (7,641 bytes)
$ mu frobnicate               (3.13.3) 3,245 bytes
```

Root help is 2.4x bigger than 3.13.3's (long descriptions on `wait`, `state`, `sql`, `me`, `delegates`). Every wrong guess costs ~2k tokens.

### F6 `df1_agent_close_two_calls`

```
$ mu agent close worker-1 -w swayward
Close worker-1? pane %0 will be killed and its row removed (rev 21409813741483)
  owns swayward/devrun-stray-proc-error (CLOSED)
  worktree /tmp/dogfood1/state/worktrees/swayward/worker-1: clean-unmerged
Apply this close : mu agent close worker-1 -w swayward --if 21409813741483
```

Three times two calls. The skill covers the `--if` step only under Stopping. The preview is useful (it names the unmerged worktree); the gap is one skill line.

### F7 `df1_skill_wait_stale`: skill draft wait text out of date

`orchestrator-loop.md` step 4 says `Exit 5: timeout. 6: pane died, task reopened`: observed exit 6 with the task closed (F1). `SKILL.md` and `orchestrator-loop.md` still show `TODO(v_hints)` and `TODO(v_wait_surface)`; `mu --help` documents `mu wait`; the spawn hint prints a third verb (`mu agent wait <a> --after-runs 0 --inc <id> --json`). The agent named the TODOs and the verb split as misleading.

### F8 `df1_isolated_install_recipe`

Running a pi orchestrator on the checkout needs six non-obvious things (listed in the task). I found them by trial: the global pi extension `~/.pi/agent/extensions/mu.ts` loads the 3.13.3 extension unless pi gets `-ne -e dist/extension/mu-pi.js`; workers need `MU_PI_COMMAND`; inherited `MU_DB_PATH`, `MU_CTL_SOCK`, `MU_AGENT_NAME` from a 3.x worker pane point `mun` at the live DB (my own pane has them; I unset them in `env.sh`).

### F9 `df1_ceiling_not_enforced`

Umbrella: `CONCURRENCY: workers 2`. Log: `agent spawn worker-3` 08:16:03, `agent close worker-1` 08:16:07; worker-1 (task CLOSED) and worker-2 were still alive at the spawn: 3 panes. The orchestrator's final message said "at most 2 were alive at once". No warning.

### F10 lock dir follows the default state dir, not `MU_DB_PATH` (code reading, not filed alone)

`src/file-lock.ts:locksDir()` is `defaultStateDir()/locks` and `src/main.ts` puts the compile cache under `defaultStateDir()`; `src/agents/lock.ts` and `src/remote-collect.ts` use `dirname(db)/locks`. So a run with `MU_DB_PATH` but no `MU_STATE_DIR` (as the crew's workers have) still touches `~/.local/state/mu-next`. I did not reproduce it with a write there. Folded into `df1_isolated_install_recipe` (set both vars).

### F11 `mun sql` default row cap hides rows

`mun sql "<edge join>"` returned 54 of 60 rows with `"more":6,"retrieve":"mu db query '...' --all"`; `mun sql --full` is refused (`too many arguments`), `--all` works. The hint is right; I first compared 54 to 60 and thought the Move had lost 6 edges (all `-> post-beta-compliance-backlog`). Cost: three extra queries. Not filed: the cap and hint are by design (Pillar: capped readers name the way back); noted for the recipe step 4: use `--all`. Folded into `df1_move_drops_later_notes`'s fix target.

## Per-command overhead vs 3.13.3

`bench.sh`: cold = first call after `rm -rf <state>/compile-cache`, warm = median of 7 consecutive calls, wall ms via `date +%s%N`, same host, same machine load (crew running), one run. Moved DB: `mun` 786 KB v13 (57 tasks, 63 edges, 130 notes, 3 workers' runs). 3.13.3 comparison DB: `small3x.db`, the same 57 tasks and 60 edges built through 3.13.3 (504 KB). Also the real 3.x DB copy (123 MB, 2425 swayward tasks, 668 next-build).

| Command | mun cold | mun warm | 3.13.3 cold | 3.13.3 warm | Δ warm |
| --- | --- | --- | --- | --- | --- |
| `--version` | 83 | 63 | 71 | 60 | +3 |
| `task list -w swayward` | 102 | 77 | 89 | 78 | -1 |
| `state -w swayward` | 110 | 93 | 101 | 88 | +5 |
| wait setup (`mun wait task:... --timeout 0.2` vs `mu task wait ... --timeout 0.2`) | 339 | 279 | 302 | 286 | -7 |
| `task next -w swayward` | 88 | 73 | 81 | 97 (noisy: 69-112) | -24 |
| `task show <id>` | 90 | 74 | 86 | 67 | +7 |
| 3.13.3 on the 123 MB copy: `task list` / `state` | | | 122 / 125 | 103 / 110 | (mun has no equivalent DB of that size: v_import dropped by the Move decision) |

Reading: on the same small fixture mun and 3.13.3 are within ±8 ms (±10%) warm, ±15 ms cold; the one outlier (`task next`) is 3.13.3's noise (69-112). The 200 ms "wait setup" is dominated by the 0.2 s timeout both sides use, so its ~80 ms overhead over `task list` is the same too. The real 3.x DB's cost (103 vs 78 ms for `task list`) is the DB size, which the Move avoids by carrying only open tasks. Not measured here: a mun DB at 3.x scale, the 94k-op replay, and memory (part B).

## What worked

- Move recipe end to end in 14 s with the verify step catching nothing wrong (and one false alarm from the row cap).
- `agent spawn --task --send -`: claim and brief in one call, 3/3.
- Workers closed with `--evidence`; reaper cleared owners; `task close --if-ready` on the umbrella.
- Hints were mostly executable (`Next:` lines were run verbatim by the agent for `agent close`, `git log HEAD --not`).

## Not covered (part B)

Delegates and no-client, settle, hints, `mu wait` through the agent, CLOSE block on a remote host, restart and replay, the human stop, herdr, cold-start import time at 53 MB.

## Reproduce

Files in `/tmp/dogfood1` (throwaway, not committed): `env.sh`, `bin/mun`, `piwrap.sh`, `move.py`, `orch-prompt.md`, `bench.sh`, `bench.txt`, session jsonl under `sessions/`. The session logs and `orch-calls.txt` are the source of the quoted tails.
