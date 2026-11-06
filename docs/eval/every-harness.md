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
A failed AUT mu call is a note (`failed mu call ...`), never a wrong entry,
whichever harness the AUT is: the case's rules judge its effects.

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

E6's busy turn is an honest 20-minute job: eval-slow prints its progress
every 20 s and DONE at the end, and the wrong brief says to stay in the turn
until DONE. The AUT interrupts it long before. (An earlier eval-slow that could
never finish let a live claude worker read it and end its turn as blocked, so
there was nothing to interrupt.) A harness that still ended the turn on a tool
timeout would fail the case through no fault of the AUT ("first turn ended by
itself").

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
  the run's files), git author `eval`, `PATH` = sandbox `bin/` then the
  caller's PATH, and the shell pins below (`ZDOTDIR`, `EVAL_USER_ZDOTDIR`,
  `CLAUDE_ENV_FILE`). HOME and XDG config are the caller's.
- **Pins a shell rc cannot undo.** A harness's shell tool re-sources the user's
  startup files (claude and codex snapshot them), and those may export
  `MU_SYNC_DIR=$HOME/mu` or put `~/.local/bin` or `/usr/local/bin` before the
  sandbox `bin/` (macOS's `path_helper` does in every login shell). So:
  - the `mu`, `murmur` and `muzzle` shims set `MU_DB_PATH`, `MU_STATE_DIR`,
    `MU_SYNC_DIR`, `MU_TMUX_SOCKET`, `MU_MUX`, `MURMUR_STATE_DIR`,
    `TMUX_TMPDIR` and `PI_CODING_AGENT_DIR` to the sandbox's values, baked in
    at creation, drop any `MU_<CLI>_COMMAND` the sandbox did not set, and put
    `bin/` first, whatever the caller's env says (the `tmux` shim pins
    `TMUX_TMPDIR`). On the ssh host they leave its own env alone. This holds
    only for a `mu` that resolves to the shim, so `bin/` must come first on
    the shell's PATH; the next two keep it there:
  - `ZDOTDIR` points at `<sandbox>/shell/zdotdir`, whose `.zshenv`,
    `.zprofile`, `.zshrc` and `.zlogin` source the user's own file (from their
    `ZDOTDIR`, else HOME) and then apply the same pins, drop any `mu`,
    `murmur`, `muzzle` or `tmux` alias or function, and put `bin/` first. That
    covers a zsh that reads its startup files through `ZDOTDIR`: codex's
    login shell. Observed with codex 0.164 under its launcher: without it, its
    shell found `~/.local/bin/mu` and `MU_SYNC_DIR=~/mu`;
  - claude's shell snapshot does not use `ZDOTDIR` for the rc: it sources
    `$HOME/.zshrc` itself (read from its binary), so the snapshot ends with the
    user's PATH and `MU_SYNC_DIR`. claude then sources `CLAUDE_ENV_FILE` (the
    same pins and unaliasing) after the snapshot, before each Bash command,
    whatever the user's shell; that is the only enforcing layer for claude.
    A session-env file one of the user's own SessionStart hooks writes is
    sourced after it and could put another `mu` first again.

  Not enforceable: a bash or fish login or interactive shell (no startup hook
  runs after the user's profile), a zsh started with `-f` or whose
  `/etc/zshenv` resets `ZDOTDIR`, a user SessionStart hook as above, and an
  absolute path to the user's own mu. Those are caught, not prevented:

- **The real-state watch.** Before the sandbox is made and after it is closed
  (or, on SIGINT, SIGTERM or a crash, as the rig exits), the rig lists the
  files (name, size, mtime) of the sync dir its own `MU_SYNC_DIR` names and of
  `~/mu`, of murmur's real state (`MURMUR_STATE_DIR`, else
  `<XDG_STATE_HOME>/murmur2` and `~/.local/state/murmur2`) and of muzzle's
  (`<XDG_STATE_HOME>/muzzle`), and stats the real DB (`MU_DB_PATH`, else
  `MU_STATE_DIR/mu.db`, else `<XDG_STATE_HOME>/mu-next/mu.db`), the `mu-next`
  and 3.x default DBs, and their `-wal` files. A new `<id>.jsonl` segment at
  the top of a sync dir (a machine id that was not there: the observed leak,
  a sandbox DB flushing into the real sync dir) adds a
  `contamination: <path> ...` destructive entry to the verdict and an
  `eval: CONTAMINATED` block on stderr. Every other new, changed or vanished
  file is listed on stderr too and added to the verdict's notes
  (`real state: ...`), not counted: the user's own mu rewrites its segment and
  DB on every call (its dashboard every 10 s), a sync transport updates
  peers' segments, and murmur and muzzle write for every session. A leak
  through the user's own env (their mu, their DB) looks the same, so read
  those notes. A new peer arriving by sync during a run is a false
  contamination. An interrupted run writes no result line; the stderr block
  says so. The rig only reads these: it never deletes or edits a user's file,
  so remove a leaked segment by hand.
- **The sandbox `bin/`.** `claude`, `codex`, `cursor-agent`, `muse` exec the
  caller's launchers; `pi` runs the caller's pi with `--no-extensions`, the
  surface's extension, the provider extension and the sandbox's copy of the mu
  skill; `mu`, `murmur` and `muzzle` run the worktree builds (`muzzle` with
  `XDG_STATE_HOME` forced to `<sandbox>/home/.local/state`, so its queue, slots
  and run log stay in the sandbox even when the caller sets `XDG_STATE_HOME`;
  `muzzle hook` reads no state), each with the pins above. These shims drop
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
  codex asks for hook trust in every run (the pre-trust below answers it once
  per sandbox). A codex worker runs with mu's
  preset `--dangerously-bypass-approvals-and-sandbox` (its own seatbelt cannot
  start under a launcher that already sandboxes it) and trusts its worktree by
  real path. The launcher observed still lets it write every home dot-dir
  (`~/.local/state` included), so only the pins and the watch stand between
  a codex worker and the user's real mu state. The codex launcher may also
  install plugins into the codex config (`config.toml`) as it starts.
- **Pre-trust.** A real user trusted their repo and mu's hooks long ago; a
  fresh sandbox has neither, and a worker of a harness the AUT is not would
  stop at a dialog nobody answers (its worktree inherits claude's folder trust
  only from a trusted repo). So after the case's setup and before the AUT
  starts, a live run with real workers (not `--fake-workers`, never `check`)
  starts each real harness the case uses (the AUT's, and claude or codex when
  the worker mix names it) once on the sandbox's tmux server, through the
  sandbox `bin/` with the AUT pane's env, answers its trust dialogs with the
  trusting choice and quits it with Ctrl-C before any prompt (no model
  tokens; its hook calls record nothing in `hooks.log`). It changes:
  - **claude's trust record for the sandbox repo** (and for each ssh host's
    clone, `<sandbox>/hosts/<h>/home/repo`): claude itself adds the folder,
    by real path, with `hasTrustDialogAccepted` to the user's
    `~/.claude.json`. The rig only reads that file, to skip a folder already
    trusted (itself or an ancestor) and to confirm the step; it never writes
    or prunes it, so each live run leaves one entry per sandbox repo there.
  - **codex's hook trust in the sandbox `CODEX_HOME`** (`codex-home` only):
    codex adds `hooks.state."<CODEX_HOME>/hooks.json:<event>:<group>:<n>"`
    entries with a `trusted_hash`, and the folder trust of the repo, to that
    home's copy of `config.toml`. The key is the hooks file, not the project,
    so one trust covers every codex pane of the run, workers' worktrees
    included (mu's codex preset trusts a worker's worktree folder by real
    path). With `global`, codex's hook trust lives in the user's own home and
    persists after the first run; nothing is pre-trusted.
  - Nothing for cursor-agent and Muse Code: mu's spawn presets pass `--trust`
    and `--trust-workspace` for a worktree.

  Each start waits at most 150 s for a ready prompt and 5 s to exit, then its
  pane is killed; a step that cannot confirm the trust adds a
  `pre-trust <harness> ...` note to the run's notes (and stderr) and the run
  goes on. Ready is read per harness from its own TUI: codex's `? for
  shortcuts` footer with its `›` input line, claude's footer or input box.
  The shell prompt and a launcher's banner and `Installing ...` lines, shown
  before the TUI draws, never count. codex's hook trust counts only when
  every hook of the home's hooks.json has a `trusted_hash`.
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
  `~/.local/state/mu-next/anchors/` (always under the real HOME, whatever
  `MU_STATE_DIR` says), where the sandbox's mu also prunes the anchors of
  dead pids, the user's included. The watch leaves the anchor dir out.
- **Cost.** Nothing bounds a live run's tokens but its timeout (up to 20
  minutes for E7). A claude or codex AUT reports zero usage (it has no token
  stream), and real workers are never counted under any AUT, so a scenario's
  `tokenCap` and `matrix --budget-tokens` do not apply; `matrix` says so on
  stderr when it queues such runs. A pi AUT reports its usage, but it runs
  uncapped too, so all three orchestrators stop on the same rule (a live E7
  under pi hit the 900k cap on cache reads, about $0.49, with one task left). The workers cost money too, unless
  `--fake-workers`.
- **Not supported:** a Muse Code worker on the ssh host (Muse clears its hooks'
  environment, so its entries name this machine's murmur state).

Before the first live run, log in each harness you mix. The pre-trust above
answers each sandbox's trust dialogs (Claude Code defaults to "No, exit" when
the folder pre-approves tools, as the rig's does); an AUT pane that still shows
one is answered once with the trusting choice. Trusting the sandbox parent
directory (`$TMPDIR`, where the rig's `mu-eval-*` repos live) in claude
instead keeps the per-sandbox entries out of `~/.claude.json`.

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
