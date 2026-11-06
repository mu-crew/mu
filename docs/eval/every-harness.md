# Every harness first-class: evals E1–E7 (U24)

Spec: [every harness first-class](../specs/2026-11-05-every-harness-first-class.md), unit U24.
Each case must meet its written pass criterion with claude, codex and pi
orchestrators. **Status: template.** The judges are proven at zero model cost
(below); the live runs have not been made, and every results table is empty.

## What a case measures

A case is a black-box scenario in `tools/eval/scenarios/e<N>_*.ts`. The
orchestrator under test (AUT) is a real claude, codex or pi; its workers are
real claude, codex, cursor-agent, Muse Code or pi panes on the sandbox's
private tmux server, locally or on the ssh host `dev` (the eval ssh shim: a
directory on this machine). A worker's job is the same cheap step on every
harness: its task says to run `eval-worker` and reply with its output, which
commits the task's file as the worker and prints the CLOSE block. A case
measures the orchestrator and mu's harness integration (spawn, brief, paste,
ack, settle, last text, close, interrupt, remote reads, checks), not a worker's
coding.

Judges assert effects, never spellings (tools/eval/README.md): the ops log and
DB, `runs.log` (where the work ran and which commit it made), the observer
hook's `hooks.log` (which harness reported for an agent, its prompts, stops and
interrupts), git, and the main-commit log. A fake harness's own logs are never
read, so a judge holds live. The shared rules are in `tools/eval/harness-cases.ts`.

| Case                             | Workers                                 | Pass criterion (written in the scenario file)                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 `e1_dispatch_merge`           | claude, codex                           | d1 and d2 CLOSED; each main commit is its own worker's (or a cherry-pick of it); each worker ran locally in its own worktree, was spawned with the requested cli and its hooks reported as that harness; no close before the worker's report; both workers closed; nothing destructive                                                                                       |
| E2 `e2_cross_family_refuter`     | codex (claude when the AUT is codex)    | a check on f1 carries REFUTED; its checker's model family differs from the AUT's (claude anthropic, codex openai, pi its model's); rf1's report came from a worker of that harness; the verdict was recorded after that report and says what it says; f1 closed only after the verdict; refuter closed                                                                       |
| E3 `e3_review_gate`              | codex implementer, claude reviewer      | i1's commit is its codex worker's; a check on i1 says CONFIRMED, names claude and was recorded after the reviewer's report; the reviewer is a claude worker and not the implementer; i1 reached main only after the verdict; ship closed after the verdict and the merge; both workers closed                                                                                |
| E4 `e4_replacement_orchestrator` | claude, codex                           | the orchestrator crashed and the replacement prompt was delivered; c1 and c2 each pass the E1 rule; each task claimed once and each worker prompted once (no re-dispatch, no resend); exactly two workers spawned; both workers closed                                                                                                                                       |
| E5 `e5_remote_worker`            | claude on dev                           | r1's commit is the remote worker's; its eval-worker ran under the host's home; its hooks fired on dev as claude; r1 closed after the report; no remote working copy left; worker closed                                                                                                                                                                                      |
| E6 `e6_interrupt_resend`         | claude, codex                           | each worker accepted exactly two prompts (the wrong brief, one resend); no turn ended between them, and codex reported its interrupt; the resend says eval-worker and does not carry the first prompt's text (mu clears the input line before its paste); an AUT mu call carried it; each task then passes the E1 rule with its report after the resend; both workers closed |
| E7 `e7_mixed_crew`               | codex and pi here, claude and pi on dev | m1–m4 each pass the E1 rule for the requested harness and place (a pi worker reports through ctl, never hooks); no remote working copy left; all four workers closed                                                                                                                                                                                                         |

E4's crash: in `check` the AUT script's `{die}` step is the crash; live, the rig
kills the AUT's harness process once both tasks are claimed and both workers'
harnesses took their prompt, then starts `aut-2` with the replacement prompt
(pi: a second rpc pi).

E6's stuck turn relies on the harness's shell-tool timeout ending a call, not
the turn: claude's Bash stops a command after 2 minutes by default, and codex's
exec returns a still-running command after a few seconds. The wrong brief says
to run `eval-slow` again each time it stops without printing DONE, and it never
prints DONE, so a real worker stays in its first turn until it is interrupted.
A harness that ended the turn on a tool timeout would fail the case through no
fault of the AUT ("first turn ended by itself").

## Proving the judges (zero model cost)

Every case has a golden and at least three bad scripts
(`<id>.golden.next.json`, `<id>.bad*.next.json`). `check` runs each under each
AUT harness: pi over rpc with the faux model, claude and codex as fake harness
binaries in a pane (`tools/eval/fake-harness.ts`). The workers are fake claude,
codex, cursor-agent and Muse Code binaries that read their pane like the real
ones (bracketed paste, `C-u`, Escape) and fire the real ones' hooks from the
real ones' config files, with the payload keys the U0 spike recorded
(`test/eval/fixtures/hook-payload-shapes.json`; Muse's hooks get its cleared
environment). mu, murmur, muzzle and the observer hook run for real. A golden
must pass clean; each bad must be flagged.

```bash
npm run build                                   # mu's dist/ (the surface)
(cd ../murmur && npm run build)                 # murmur's dist/
export EVAL_MURMUR=$PWD/../murmur               # required by every E case
export EVAL_MUZZLE=$PWD/../muzzle               # optional: muzzle's hook entries
export TMPDIR=/tmp                              # tmux socket paths stay short
node tools/eval/main.ts check --family next --no-preflight \
  --scenarios e1_dispatch_merge,e2_cross_family_refuter,e3_review_gate,e4_replacement_orchestrator,e5_remote_worker,e6_interrupt_resend,e7_mixed_crew
node tools/eval/main.ts check --family next --scenarios e6_interrupt_resend --harness claude   # one case, one AUT
```

Without `EVAL_MURMUR`, `check` prints `<id> skipped (...)` for each E case and
runs the other scenarios.

The fast tier pins the same criteria without tmux:
`test/eval/harness-judges.test.ts` (synthetic end states for every golden and
for each bad script's failure), `runner-pane.test.ts` (the pane runner's crash
and replacement, the pi AUT's two phases), `fake-payloads.test.ts`,
`harness.test.ts`, and `check.test.ts`. The full tier's
`test/eval/harness-check.integration.test.ts` runs `check` on every case under
a claude orchestrator and E6 under codex too, with the fake binaries; it is
skipped unless `EVAL_MURMUR` names a built murmur.

## What a live run changes

A run with a hook-harness case, or with `--harness claude|codex`, is live: the
AUT and its workers are the user's own harness binaries with the user's HOME
and auth (spec D1). The rig changes exactly this:

- **Environment of the AUT and its panes.** The caller's environment minus
  `MU_*`, `TMUX*`, `HERDR_*`, `MURMUR_*`, `PI_*`, `EVAL_*` and each harness's
  session and nesting markers, named one by one (`LIVE_DROP` in
  `tools/eval/sandbox.ts`): `CLAUDECODE`, `CLAUDE_PID`,
  `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_CURRENT_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_MESSAGING_*`,
  `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_TMPDIR`,
  `CLAUDE_PROJECT_DIR`, `CLAUDE_ENV_FILE`, `CLAUDE_PLUGIN_*`,
  `CLAUDE_LAUNCHER_SESSION_FILE`, `CODEX_SESSION_ID`, `CODEX_THREAD_ID`,
  `CODEX_TOOL_CALL_ID`, `CODEX_CI`, `CURSOR_AGENT`, `CURSOR_CONVERSATION_ID`,
  `CURSOR_REQUEST_ID`, `CURSOR_TRANSCRIPT_PATH`, `CURSOR_PROJECT_DIR`,
  `CURSOR_ASKPASS_*`, `MUSE_SESSION_ID`, `MUSE_THREAD_ID`, `MUSE_PLUGIN_*`.
  Configuration and auth variables (`CLAUDE_CODE_USE_*`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*`, `CODEX_HOME`, ...) stay. Set: `MU_DB_PATH`, `MU_STATE_DIR`,
  `MU_SYNC_DIR`, `MU_TMUX_SOCKET`, `MU_MUX=tmux`, `TMUX_TMPDIR`,
  `MURMUR_STATE_DIR`, `PI_CODING_AGENT_DIR` and `TMPDIR`, all inside the sandbox
  (TMPDIR is the sandbox root, so a harness sandbox that allows TMPDIR reaches
  the run's files), git author `eval`, and `PATH` = sandbox `bin/` then the
  caller's PATH. HOME and XDG config are the caller's.
- **The sandbox `bin/`.** `claude`, `codex`, `cursor-agent`, `muse` exec the
  caller's launchers; `pi` runs the caller's pi with `--no-extensions`, the
  surface's extension, the provider extension and the sandbox's copy of the mu
  skill; `mu`, `murmur` and `muzzle` run the worktree builds (`muzzle` with
  `XDG_STATE_HOME` forced to `<sandbox>/home/.local/state`, so its queue, slots
  and run log stay in the sandbox even when the caller sets `XDG_STATE_HOME`;
  `muzzle hook` reads no state). These shims drop
  `murmur hook <harness>`, `mu hook stop` and `muzzle hook` calls, which only
  the user's own hook entries make (a harness also reads them): only the rig's
  entries, which run the builds by absolute path, record anything.
- **Hook entries.** Committed in the sandbox repo, so every worktree and the
  host's clone has them: `.claude/settings.json` (with a `permissions.allow`
  list for mu, git, eval-worker and plain reads, so a claude in `acceptEdits`
  does not stop at a dialog), `.cursor/hooks.json`, `.muse/hooks.json`. Each
  harness gets the observer hook, murmur's events, mu's Stop entry (not Muse,
  D7) and muzzle's tool entry. ~/.claude, ~/.cursor and Muse's config are never
  written.
- **The mu skill each AUT reads.** pi: the sandbox's copy of the surface's
  skill and no other (`--no-skills --skill`). claude: the surface's copy,
  committed as the project skill `.claude/skills/mu` in the sandbox repo; but a
  personal skill of the same name takes precedence over a project one, so with
  a `~/.claude/skills/mu` that differs from the surface's the AUT reads the
  user's. codex: with `EVAL_CODEX_HOOKS=codex-home`, the surface's copy in
  `<sandbox>/codex-home/skills/mu` (beside links to the user's other skills);
  with `global`, whatever `<codex home>/skills/mu` the user has. The rig never
  writes either personal skill. When the AUT may read another version it says
  so on stderr and in the result's notes (`claude AUT: ...`, `codex AUT: ...`);
  for a comparison of surfaces, remove or update the personal skill first, and
  run codex with `codex-home`.
- **codex.** codex reads hooks only from its home, the caller's `CODEX_HOME`
  or else `~/.codex`. `EVAL_CODEX_HOOKS=global` (default) copies its
  `hooks.json` to `hooks.json.mu-eval-<pid>`, adds the rig's entries after the
  user's, and moves the copy back when the last live sandbox of the eval
  process closes, on SIGINT, SIGTERM and crashes too; a later run restores a
  backup whose owner died before it starts, and refuses while a live one holds
  it. Concurrent sandboxes of one `matrix` share that install when their
  entries are the same (one surface); a sandbox of a second surface is refused
  while another is live (that run fails with a message; use `--concurrency 1`
  or `codex-home`). The rig's codex entries are the same every run, so codex
  asks to trust them once (codex records that in its `config.toml`). Do not use
  codex elsewhere during such a run. `EVAL_CODEX_HOOKS=codex-home` instead
  points `CODEX_HOME` at `<sandbox>/codex-home` (the rig's hooks.json, a copy
  of config.toml, links to the other top-level files, auth included, and the
  skills/ above): nothing in the real codex home is written by the rig, but
  codex asks for hook trust in every run.
- **The ssh host `dev`.** Its HOME is `<sandbox>/hosts/dev/home`, live or
  fake, so mu's state there (anchors, and the remote worktrees in
  `~/.local/state/mu-next/remote-worktrees/eval/<worker>`) is the sandbox's and
  the judges find it. A live run links the harnesses' config, auth and installs
  from the caller's HOME into it: `.claude`, `.claude.json`, `.codex`,
  `.cursor`, `.pi`, `.config`, `.local/share`, `.local/bin` and, on macOS,
  `Library` (the keychain). A harness on the host writes through those links as
  it would at home. The host's murmur state is `<sandbox>/hosts/dev/murmur`.
- **Written by the harnesses and mu, as in any run.** Each harness's own
  sessions, trust records and state under the caller's HOME (claude records
  folder trust in `~/.claude.json`); mu's anchor files for local workers in
  `~/.local/state/mu-next/anchors/`.
- **Cost.** Nothing bounds a live run's tokens but its timeout (up to 20
  minutes for E7). A claude or codex AUT reports zero usage (it has no token
  stream), and real workers are never counted under any AUT, so a scenario's
  `tokenCap` and `matrix --budget-tokens` do not apply; `matrix` says so on
  stderr when it queues such runs. The workers cost money too, unless
  `--fake-workers`.
- **Not supported:** a Muse Code worker on the ssh host (Muse clears its hooks'
  environment, so its entries name this machine's murmur state).

Before the first live run: trust the sandbox parent directory in claude
(the rig's repos live under `$TMPDIR/mu-eval-*`; an AUT pane that shows a trust
dialog gets one Enter, the default answer), and log in each harness you mix.

## Running each case live

From the repo root, with the builds and exports above (`EVAL_MUZZLE` included).
`--model default` keeps each harness's own default; `--model <id>` passes it
through the harness's model flag. A pi AUT needs a model; it uses pi's own providers unless `--provider-ext <file>`
names a provider extension.
Results append to `docs/eval/every-harness.jsonl`;
`node tools/eval/main.ts report docs/eval/every-harness.jsonl` renders them.

```bash
S="$PWD:next"; OUT=docs/eval/every-harness.jsonl
for id in e1_dispatch_merge e2_cross_family_refuter e3_review_gate e4_replacement_orchestrator \
          e5_remote_worker e6_interrupt_resend e7_mixed_crew; do
  node tools/eval/main.ts run "$id" --surface "$S" --harness claude --model default --out "$OUT"
  node tools/eval/main.ts run "$id" --surface "$S" --harness codex  --model default --out "$OUT"
  node tools/eval/main.ts run "$id" --surface "$S" --harness pi     --model <provider/model> --out "$OUT"
done
```

One case and AUT at a time is the same line without the loop, e.g.
`node tools/eval/main.ts run e6_interrupt_resend --surface "$PWD:next" --harness codex --model default --keep --out docs/eval/every-harness.jsonl`
(`--keep` leaves the sandbox for a post-mortem). `--fake-workers` keeps fake
worker binaries with a real AUT (only the AUT costs). `EVAL_AUT_COMMAND`
replaces the AUT pane's command (e.g. `claude --permission-mode auto`).

## Results

Empty until the live runs. One row per run: `completed` is the case's pass
criterion; `wrong` and `destructive` are the judge's entries, verbatim.

### E1 dispatch and merge

| AUT    | Date | Model | Completed | Wrong / destructive | Wall | Notes |
| ------ | ---- | ----- | --------- | ------------------- | ---- | ----- |
| claude |      |       |           |                     |      |       |
| codex  |      |       |           |                     |      |       |
| pi     |      |       |           |                     |      |       |

### E2 finding triage with a cross-family refuter

| AUT    | Date | Model | Completed | Wrong / destructive | Wall | Notes |
| ------ | ---- | ----- | --------- | ------------------- | ---- | ----- |
| claude |      |       |           |                     |      |       |
| codex  |      |       |           |                     |      |       |
| pi     |      |       |           |                     |      |       |

### E3 review gate

| AUT    | Date | Model | Completed | Wrong / destructive | Wall | Notes |
| ------ | ---- | ----- | --------- | ------------------- | ---- | ----- |
| claude |      |       |           |                     |      |       |
| codex  |      |       |           |                     |      |       |
| pi     |      |       |           |                     |      |       |

### E4 crash and replacement orchestrator

| AUT    | Date | Model | Completed | Wrong / destructive | Wall | Notes |
| ------ | ---- | ----- | --------- | ------------------- | ---- | ----- |
| claude |      |       |           |                     |      |       |
| codex  |      |       |           |                     |      |       |
| pi     |      |       |           |                     |      |       |

### E5 remote worker

| AUT    | Date | Model | Completed | Wrong / destructive | Wall | Notes |
| ------ | ---- | ----- | --------- | ------------------- | ---- | ----- |
| claude |      |       |           |                     |      |       |
| codex  |      |       |           |                     |      |       |
| pi     |      |       |           |                     |      |       |

### E6 interrupt and resend

| AUT    | Date | Model | Completed | Wrong / destructive | Wall | Notes |
| ------ | ---- | ----- | --------- | ------------------- | ---- | ----- |
| claude |      |       |           |                     |      |       |
| codex  |      |       |           |                     |      |       |
| pi     |      |       |           |                     |      |       |

### E7 a mixed crew

| AUT    | Date | Model | Completed | Wrong / destructive | Wall | Notes |
| ------ | ---- | ----- | --------- | ------------------- | ---- | ----- |
| claude |      |       |           |                     |      |       |
| codex  |      |       |           |                     |      |       |
| pi     |      |       |           |                     |      |       |
