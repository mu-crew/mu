# Dogfood: mu with codex and cursor-agent

Task `dogfood_harnesses`. Checkout `14a4f53` + `npm run build`, never installed.
Host linuxpc, 2026-10-27 09:40 to 10:05. codex-cli 0.164.0 (gpt-5.6-sol low),
cursor-agent 2026.10.22 (model `auto`), pi workers on
claude-haiku-5-5, tmux 3.7c on a private socket (`MU_TMUX_SOCKET=m4`), murmur
1.3.2. No herdr on this host, so every non-pi row below is tmux.

## Setup

- `/var/tmp/m4/env.sh` unsets inherited `MU_*`, `PI_*`, `TMUX*`, `HERDR*` and
  sets `MU_STATE_DIR`, `MU_DB_PATH` (under `/var/tmp/m4/state`),
  `MU_SYNC_DIR=` (blank), `MU_TMUX_SOCKET=m4`, `TMPDIR`, and
  `MU_PI_COMMAND=piwrap`.
- `/var/tmp/m4/bin/mu` sets the same four `MU_*` itself, then runs
  `node <checkout>/dist/cli.js`. It is first on `PATH`.
- `codexw` = `codex --disable shell_snapshot --disable hooks
  --dangerously-bypass-approvals-and-sandbox -c 'projects."<repo>".trust_level="trusted"'`.
  `cursorw` = `ZDOTDIR=<empty dir> cursor-agent --force --trust --model auto`.
  Why the flags: F1 and F2.
- One throwaway git repo (`math.js`), workstreams `h1` (workers), `o1`/`o2`
  (orchestrators), `scratch` (delegation), `c1` (no mux).

## Matrix

| Harness | Role | Capability | Result |
| --- | --- | --- | --- |
| codex | worker | spawn `--cli codex --task --send -` | **no** on tmux: `AgentSendUnsupportedError` (exit 4), spawn rolled back (no pane, no claim, no worktree) |
| codex | worker | spawn with the prompt in `--command`, then `task claim --for` | works (worker-1: edit, commit, `task note`, `task close --evidence` via mu) |
| codex | worker | state | degraded: `unknown: murmur has no row` until codex's `notify` fires, then `needs_input` (source murmur); never `busy` |
| codex | worker | `mu wait task:<id>` | works (exit 0, `closed`) |
| codex | worker | `mu wait agent:<w>` | **no**: hangs until timeout when no `busy` reading was seen (F4) |
| codex | worker | `mu wait agent:<w> --until-text` | works: `pane-text` event |
| codex | worker | `--stuck-after` stall | degraded with `notify`: false stall 15 s into a 40 s `sleep`; works with the `Stop` hook (F3) |
| codex | worker | `agent read` | works (pane text) |
| codex | worker | `agent send` (idle or mid-run) | **no** on tmux (exit 4, by design); herdr not tested |
| codex | worker | `agent abort` | **no**: "abort needs the mu pi extension; close the agent instead" |
| codex | worker | `agent close` (preview, `--if`) | works; the reaper reopens the task if the worker left it IN_PROGRESS |
| codex | worker | CLOSE-block apply | n/a: ctl `lastText` only; the worker closed its task with verbs |
| cursor-agent | worker | same as codex | same, except state stays `unknown` with no hook. `.cursor/hooks.json` `stop` → `murmur notify` gives `needs_input` at the end |
| codex | orchestrator | `codex exec`, 2 pi workers, merge, close | works: 3 min, 26.7k tokens. Read SKILL.md + orchestrator-loop, `spawn --worktree --task --send -`, waited on `task:` refs, cherry-picked, resolved the conflict, verified, closed workers with `--if` and the umbrella |
| codex | orchestrator | bare `mu wait -w o1` | **no**: UsageError "nothing to wait for ... or run as a managed agent or a pi session". Recovered with explicit `task:` refs (F5) |
| codex | orchestrator | delegation outside pi (`scratch`) | works: 50 s, 18.7k tokens. Followed tasks-or-calls' `scratch` line: `spawn r1 -w scratch`, `send --fresh --json -`, `mu wait 'agent:r1@0#<inc>'`, recorded `REFUTER 1 (r1): VERDICT ... CONFIRMED`, `close --if`. Stumbled on `workstream init scratch` (reserved) after `state -w scratch` said not found |
| cursor-agent | orchestrator | `cursor-agent -p`, 2 pi workers, merge, close | works: 80 s. Used `mu wait -w o2 task:o_sq task:o_inc --all` first time |
| any | no mux | task verbs, `sql`, `wait task:` | works |
| any | no mux | `doctor` | reports `multiplexer: NONE — install tmux ≥ 3.0`, exit 5 |
| any | no mux | `workstream init`, `state`, `agent list`, `agent spawn` | refuses, exit 5, one line naming the install (the `no_mux` eval contract) |
| any | no mux | `task add -w c1` before `init` | works: creates the workstream that `init` refused (no mux session, though) |

## Findings

**F1 (P1, user hazard): a non-pi harness's shell runs whatever `mu` `~/.zshrc`
puts first, and gets `~/.zshrc`'s `MU_*`.** codex (`shell_snapshot`, stable
and on by default) and cursor-agent run every tool command through a snapshot
of the user's interactive zsh. Here `.zshrc` puts `~/.local/bin` (3.x `mu`)
ahead of the wrapper and exports `MU_SYNC_DIR=~/mu`. The env mu put on the
pane is overridden. In the first codex worker (09:45) the pane's `mu` was
3.13.3. It printed `TaskNotFoundError` and codex guessed
`XDG_STATE_HOME=/var/tmp/m4/state mu task notes ...`. That made a fresh 3.x
DB, which ingested the real `~/mu` (117k ops) and flushed an empty phantom
segment into it. The live DB now lists that machine as a peer. Quarantined by
the orchestrator. The same thing happens to a user: a codex worker spawned by
a mu-next checkout (or any second install) drives whichever `mu` the rc file
chooses. Verified mitigations: codex `--disable shell_snapshot`; cursor-agent
`ZDOTDIR=<dir with an empty .zshrc>`. Check from inside the harness before
any run: `command -v mu; mu --version; echo "<$MU_SYNC_DIR>"`. pi's bash tool
did not show it. Task `triage_dfh_harness_path`.

How the env is lost, measured after the alert (10:20). The env is not
stripped: codex and cursor pass the pane's `MU_*` through, then the rc file
overwrites what it names. Here that is `PATH` (`~/.local/bin` first) and
`MU_SYNC_DIR=~/mu`. `MU_DB_PATH` and `MU_STATE_DIR`, which `.zshrc` does not
set, came through intact. codex's own env config
(`-c 'shell_environment_policy.set={...}'`) is applied before the snapshot,
so `.zshrc` still wins: with `PATH` and `MU_SYNC_DIR` set there, `mu` was
still 3.13.3, though `MU_SYNC_DIR` stayed blank. A wrapper under a name
the rc file does not shadow (`mun`, which exports `MU_SYNC_DIR=` /
`MU_DB_PATH` / `MU_STATE_DIR` itself and execs the checkout) resolved
correctly in every mode: `command -v mun` = the wrapper with snapshot on,
off, and in cursor's default shell. But the skill and every brief say `mu`,
so the agent still runs bare `mu`. Use the two mitigations above, and treat
`mun` as the orchestrator's own pin.

**F2 (P3): trust and hook dialogs block a fresh codex pane.** In a new folder
codex asks "Trust this folder?" (default "Trust and continue"), then "Hooks
need review" (a herdr hook in `~/.codex/hooks.json`). mu reports
`unknown: murmur has no row` the whole time and cannot answer either one on
tmux, because no send is possible. Pre-trust the repo with
`-c 'projects."<repo>".trust_level="trusted"'` and pass `--disable hooks`, or
press the key yourself. A worktree under the repo inherits the root's trust.
mu's Claude trust-dialog detection (`src/cli/agents.ts`) has no codex
equivalent. Not filed; the guide covers it.

**F3 (P2): codex's `notify` fires mid-turn, so a running worker reads as
`needs_input` and stalls falsely.** A codex worker was in `sleep 40`. At turn
start codex notified `{"title":"Read task notes t_st"}`, and murmur recorded
`done`. `mu wait task:h1/t_st --stuck-after 15` then exited 7 ("needs_input
for 15s") while codex was still working. It closed the task 25 s later.
Task `triage_dfh_notify_stall`. Cause: codex runs a hidden turn to title the
thread (`input-messages` "Generate a concise, single-line task title…", its
own `thread-id`), and legacy `notify` reports it as `agent-turn-complete`
(dumped with a logging `notify`, codex 0.164.0, about 2 s into the turn). So
murmur's `done` is correct for the payload it got. codex's `Stop` hook does
not fire for the title turn. Re-run on private tmux socket `m7par`, a
`sleep 40` turn, `mu wait task: --stuck-after 15`: with `notify`, exit 7 at
16 s while codex was still working; with a `Stop` hook running `murmur notify
--source codex --event-type agent-turn-complete`, no stall, and murmur's `done`
landed at the real turn end. 3.13.3 has the same stall predicate and exits 7
on the same pane state. Decision: no engine change. The guide wires codex
through `Stop`. A pane-text check on non-ctl stalls was considered and
rejected: it would cost a capture per poll per owner and still miss a worker
whose pane is quiet (a long `sleep`). This hook needs hooks enabled, so it
cannot be combined with the `--disable hooks` from F2. Trust it once instead.
Upstream note for murmur: `docs/setup.md` should recommend the `Stop` hook
over `notify` for codex.

**F4 (P2): `mu wait agent:<non-pi>` never fires.** The agent track settles on
`busy` → not busy (`src/wait.ts`, `wasBusy`). A notify-only murmur never
reports `busy`, so the wait on cursor worker-3 (task closed, murmur `done`)
and on an idle codex worker ran to the timeout. `task:` refs and
`--until-text` work. Task `triage_dfh_wait_nonpi_idle`: kept as the 3.x rule
(3.13.3's `mu agent wait` times out on the same readings), pinned by a test
in `test/wait-events.test.ts` and stated in the guide.

**F5 (P3): a non-pi orchestrator has no caller identity, so bare `mu wait`
owns nothing.** `currentCallers()` is the managed `<ws>/<agent>` or
`pi:<session>`. A codex or cursor session in a plain shell is neither, so
`mu wait -w o1` after its own spawns is a UsageError. The message names the
fix (refs). Both orchestrators recovered in one step. orchestrator-loop step 4
says "`mu wait -w <ws>` waits on what you started", which is true only inside
pi or a managed pane. The guide section says to wait on refs; the recipe is at its 250-word cap,
so it is unchanged (prose budget).

**F6 (P3, fixed): `task claim --for <non-pi>` suggested a send tmux refuses.**
`next` was `mu agent send <w> 'Claim done: ...'` (exit 4 on tmux). Fixed in
the `next:` commit: no send hint when the mux has no `sendToPane`, and the
refusal names the argv route.

## P3 (one line each)

1. `mu state -w scratch` before the first spawn says `WorkstreamNotFoundError`,
   and `workstream init scratch` is refused (reserved). The codex delegator
   tried both before it spawned.
2. `mu state -w o2` before `init` fails, but `mu agent list -w o2` returns
   `workstreamName: o2` (cursor's report).
3. The first codex worker did `rg` over `~/mu` and the state dir looking for
   the task before it ran `mu task notes`. The argv prompt should say "run:".

## Isolation

The F1 breach at 09:45:05 was the only write outside `/var/tmp/m4`: one
phantom segment `~/mu/99681350-*` (0 ops), a `sync_peers` row in the live DB
for it, and the 3.x DB under `/var/tmp/m4/state/mu` (moved to
`/var/tmp/m4/quarantine/`). From 09:47 every harness ran with the F1
mitigations. `command -v mu` / `mu --version` / `MU_SYNC_DIR` were checked
inside both harnesses after the alert (4.0.0-next.0, blank). Every other
command ran against the private tmux server `m4` only.
