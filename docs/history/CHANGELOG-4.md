# Changelog: mu 4

Releases 4.0.0 through 4.6.0. Newer releases: [CHANGELOG.md](../../CHANGELOG.md).

## [4.6.0] — 2026-11-11

Reading results gets cheap. `mu wait --text`, `mu agent read --text` and
`mu task notes --report` print just what an agent needs, and `mu wait
--ready` returns up to five ready events in one wait: pi's settle and the
Stop hook now drain with it, so N closes cost ceil(N/5) turns instead of N.
Each reading change won a measured tournament on weak models (hill-r2,
docs/eval/hill-r2/). A pipe now gets no colour, inside tmux too; set
`MU_FORCE_COLOR=1` for `watch --color`.

### Added

- **`mu wait --ready`: the ready batch** (hill-r2 A7, a7_ready_engine;
  proposal a7_wait_drain_rca_2 P1/P2/P4 + a7_wait_drain_rca_3 D1/D2). One
  wait returns every ready, never-returned completion, up to 5, as
  `data.events` right after `firing`; an urgent event (dead, input, stall)
  still fires alone, so exits 6 and 7 are unchanged. It is opt-in: it excludes
  `--first` and `--all`, and a resume stores it. The commit guards every
  member: a member another process consumed meanwhile is dropped, so it is
  never printed by two waits. The members are never paged out of `snapshots`.
  `reason` says "N events: …".

- **Wait results mark what they consumed** (every mode). A snapshot reads
  `delivered: true` when this result consumed it, and `owed: true` when it is
  ready news the next wait returns. A top-level `owed: N` is never cut. Paging
  order is firing, delivered, open, owed, rest. A result with owed news the
  caller owns (not a named target) gets the notice
  `N owed: mu wait --ready -w <ws>`, and its `next` is that command. While a
  named target is still owed, `next` stays the resume: a bare `--ready` never
  returns an unowned target.

- **`mu wait --text`: the result as plain lines** (task
  `land_c1_wait_text`, the C1 tournament winner
  `gemini31prop-v1-compact-text`, docs/eval/hill-r2/c1.md). Line 1 is `event: <kind> on <ref> | resume: <command>`; the
  resume keeps `--text` (and `mu wait --resume <id> --text` is allowed).
  Above a `---` line: the exit and reason, each consumed ref's state (and the
  still-open ones), a task's latest report (what `mu task notes --report`
  prints) or a delegate's answer, indented so it never reads as the
  separator, then owed, tally, human needs, the warning and the notices.
  Below `---`: only agents' last words, as `mu agent read --text` prints them.
  The JSON default is byte-identical. Landing fix over the measured patch: it
  printed `no final text` for a task ref and dropped the state, report,
  warning and notices (sonnet on `wait_heartbeat_merge` fell 6/50 to 0/50
  with it, Holm 0.12). Fast mode won on `wait_result_read` with pooled z 4.50
  (>= 2.47): haiku 41/70, gemini-3.8-flash 36/70, sonnet 35/70 (help arms).
  `mu_delegate`'s kept-pane and delivery-unknown hints now say
  `mu agent read <w> --text` (f_low_batch3).

- **`mu task notes <id> --report`: the report, raw** (task
  `land_c3_report_flag`, the C3 tournament winner,
  docs/eval/hill-r2/c3_notes.md). Prints the task's
  latest `kind=report` note as its own text (newlines intact, no `\n`
  escaping); `--json` gives `{n, kind, author, created_at, content}`. With no
  report note it exits 1 with `(no report note on <id>)` on stderr (the
  closer's-note stand-in of the default view does not count). It refuses
  `--tail`/`--last`/`--since`/`--since-claim`/`--all`/`--from`. Fast mode won
  on `notes_report_read` with pooled z 4.74 (>= 2.13): haiku 35/50 against
  base's 16, gemini-3.8-flash 44 against 29, sonnet 24 against 16.

- **`mu agent read --text` and `mu agent show --text`: just the worker's
  words** (task `land_c4_read_text`, the C4 tournament winner,
  docs/eval/hill-r2/c4.md). `--text` drops pane
  furniture and keeps every other line: blank runs fold to one, rows made
  only of box-drawing characters go, scroll markers and spinner and status
  rows go only in a harness's exact whole-row shapes, and the footer goes
  only when its structure is found (pi's editor rules with the cwd and stats
  rows under them, claude's input box with its hint row); with no footer
  found nothing is dropped at the bottom. ASCII lines (`---`, `|---|`, `***`,
  `+++`) and every row inside a ``` or `~~~` fence stay (review
  `delegate_rv-land4_6d6286e3`). With `--text`, `-n` counts text lines, read
  from the full scrollback; `--json --text -n` does the same for `text`,
  while `scrollback` keeps its raw `-n` rows. The default output is
  unchanged. `mu_delegate`'s pane tail
  and its read hints use `--text`, and the orchestrator recipe's exit-7 step
  names it. Fast mode won on `agent_read_text` with pooled z 3.51 (>= 1.96):
  gemini-3.8-flash 27/56 against base's 12, haiku a tie (46 against 48),
  sonnet 32 against 28; the win is on the help arms, where `--text` is shown
  (gemini 26/28 against 11/28).

### Changed

- **The Stop hook drains with `--ready`** (claude, codex, cursor-agent). Ready
  events arrive in one block, one line per event, plus a line for what is
  still owed, instead of one block per event. A superseded wait that consumed
  nothing lets the turn end while the newer wait is live, and otherwise waits
  once more. A partly consumed one blocks over what it delivered. The empty
  block says "run `mu wait --ready` in the background".

- **pi's settle drains with `--ready`** (hill-r2 A7, a7_ready_settle;
  proposal a7_wait_drain_rca_2 P3 + a7_wait_drain_rca_3 D1-D3). The settle
  runs `mu wait --ready --on-stall exit --json`, so N ready closes and answers
  cost ceil(N/5) turns instead of N (the crew-hill2 repro: 7 closes, 2 turns).
  A batch entry says "N events:" with one line per event, then the answer
  blocks as before (each at 1500 characters beside others). Delegates of
  several waves share ONE wait loop, and each wave is summarised once; a wave
  an earlier settle already summarised prints `wave A: 1 more in`, the tally
  line and the new answers only. Owed news gets one line ("2 more ready, not
  yet delivered: …"). A superseded result that consumed nothing is shown as
  one line and does not continue the turn; a partly consumed one shows only
  what it delivered. One event with nothing owed reads as before, byte for
  byte. The words for events are shared with the Stop hook
  (`src/wait-event-text.ts`). The orchestrator loop recipe's bare wait is
  `mu wait --ready -w <ws>`.

- **A superseded wait result is narrowed.** `delivered` keeps only the
  members whose caller's generation applied; the others read `owed`.
  `eventConsumed` says whether the firing event was consumed. Before this,
  `superseded:true` covered a result that, with two callers, had partly been
  consumed.

- **A pipe gets no colour, inside tmux too.** mu forced ANSI colour
  whenever `$TMUX` was set (67014c7a, for `watch --color mu hud`), so a
  third of agent results read through a pipe carried escape codes and
  agents stripped them with `sed`. Colour now needs stdout to be a TTY;
  `NO_COLOR`, `MU_FORCE_COLOR` and `FORCE_COLOR` keep their meaning;
  `TERM=dumb` on a TTY inside tmux is now plain, like outside it.
  `mu hud` is gone and the dashboard decides its own colour; for
  `watch --color` or a popup piped to a pager, set `MU_FORCE_COLOR=1`
  (docs/reference/env.md).

- Docs: docs/guide/sql.md now says a verb's output format never follows
  the TTY; only colour does. `mu agent list | head` printing JSON looked
  like a pipe switch, but `agent list` prints JSON on a TTY too (4.0).

- **SKILL.md: wait for all of a set, then read every outcome** (hill-r2
  C6 tournament winner `claudeopus55-wait-all`, task `land_c6_wait_all`;
  report `docs/eval/hill-r2/c6.md`). The wait rule
  now names `mu wait --all task:<ws>/<a> task:<ws>/<b>` and says to read
  each task with `mu task show` after it. To pay for the words it cuts the
  `-w <workstream>` sentence (each verb's `--help` lists `-w` or not) and
  the `mu task block A --by B` line (`task block --help` gives the
  direction). On `sleep_poll`, fast mode R1 with 50 clusters per model:
  haiku 31/50 against base 8, gemini 42 against 22, sonnet 29 against 8;
  pooled z 6.53 against a threshold of 2.01. Patch applied verbatim;
  SKILL.md drops from 599 to 595 words.

- **Course checks resume on their own** (hill-r2 s_course_auto and
  s_course_auto_2, user report 2026-11-07: three checks in one session each
  stopped for a human, though every proposal was in the plan).
  `recipes/course-correct.md` now applies in-plan changes (DAG edges, order,
  merge batching, briefs, habits) with the `COURSE CHECK` note and resumes. A
  second delegate refutes the measurement, nothing is dispatched until both
  answer, and it stops with `mu human-needed` only for scope, spend or goal
  changes, irreversible or external steps, or a judgment call (`--no-stop` for
  a to-do). The SKILL.md bullet reads "finish merging, then course-correct;
  resume only after it" (599 words, unchanged). Eval: `course_check` requires
  that the orchestrator saw both delegates' answers (not just made the calls:
  `mu_delegate` returns at once), then the note, then the resume. The new
  `course_check_escalate` hides a scope overrun in k11's and k12's notes, so it
  shows up first in the measurement, and requires both answers before the
  stop. The rig now records a settle's entries (`entry_appended`) as delivered
  messages; before, no judge saw an answer a settle delivered. On haiku ×5,
  base → candidate: course_check 0/5 → 4/5, course_check_escalate 1/5 → 4/5,
  delegate_saturation 5/5 → 5/5, refute_verdicts 5/5 → 5/5, no destructive op.
  s_course_auto_3 tightens the judge: the `COURSE CHECK` note must come after
  both answers, and each faux delegate answer carries its own id, so a re-read
  of the first answer is not taken for the second. Faux workers' close
  evidence now names their commit (`<task>: committed <sha> run=<nonce>`), no
  longer a `<task>.sh` that is not in the repo. Re-run on haiku ×5: course_check
  0/5 → 4/5, course_check_escalate 1/5 → 3/5 (two candidate runs read the
  overrun in k11's notes and stopped without measuring). That misses the keep
  rule (both ≥ 4/5).
  Log: docs/eval/hill-r2/course-auto.md.

- **The models recipe names a model per family and tier** (anthropic,
  openai, google, meta; dated 2026-11-11), so a check told to use "another
  family" knows which model sits where. Model ids come from the harness
  being spawned, latest version only; it no longer assumes
  `pi --list-models`.

- **The move recipe moves a 4.x workstream between machines**: free the
  work on the source, ship its ops by `MU_SYNC_DIR` or `mu db backup` plus
  `mu sync --from`, verify, and watch the target's dashboard. No sqlite3.
  The 3.x-to-4.0 move is now a section of `docs/guide/upgrade.md`. The
  recovery recipe says when a respawn needs `--attempt <task>-2`.

### Fixed

- **A check that pastes the verdict template is read by the label after
  it.** `VERDICT: <id> CONFIRMED|REFUTED|UNVERIFIED REFUTED <line>` recorded
  CONFIRMED (the template's first choice) and a review closed on it. Two or
  more labels joined by `|` are now the template and skipped; a line with only
  the template reads UNVERIFIED. A plain verdict line reads as before.

- **A partly superseded settle shows only what it consumed.** When a newer
  `mu wait` superseded the settle's wait after it consumed part of the batch,
  the entry's printed result still carried the unconsumed `firing`. It now
  prints only the consumed events and says the newer wait returns the rest.

- **Help text matches 4.5's behaviour.** `mu --help` names Rex beside tmux
  and herdr. `agent send --steer` says it is pi-only and that a hook harness
  refuses it (another CLI in a herdr or Rex pane gets a plain send).
  `agent send --timeout` and `agent abort --timeout` say what they wait
  for: pi, or a local hook harness that reports its interrupt (codex, muse,
  cursor-agent); claude and remote hook workers are not waited on.
  `task verdict --help` and its missing-verdict error show the skill's
  `VERDICT: <id> CONFIRMED|REFUTED|UNVERIFIED <line>` form.

- **`mu task note`'s "will not see this note" hint names a send that works
  for the owner's channel.** It always said `mu agent send <o> --steer` with
  no text argument, which a hook harness (claude, codex, cursor-agent, Muse)
  refuses: it has no mid-turn steer. Now a ctl owner gets `--steer -` (or
  `--interrupt`), a hooks owner `mu agent wait` then a plain send (or
  `--interrupt`), a mux owner a plain send; every variant shows the text as
  `- <<'EOF'`, and `-w` names the owner's own workstream.

- **SQL refusals name the verb you typed.** `mu sql` refusals (BEGIN/COMMIT,
  PRAGMA, ATTACH, DDL, id changes, bookkeeping writes, the `--write` opt-in)
  and a capped read's `retrieve` said `mu db query` (or always `mu sql`); each
  now names `mu sql` or `mu db query` as typed.

- **Guessed verbs name the command that works.** `mu finding` points at
  `mu task show` (a finding is an `OPEN/triage` task), `mu findings` at
  `mu task list --substate triage`, `mu ready` / `mu task ready` at
  `mu task next -n 0`, `mu delegates check|verdict` at `mu task check|verdict`.
  An unknown first word after `mu delegates` (whose default verb is `list`)
  is now `unknown command 'x'` with the closest verb, not "too many arguments
  for 'list'".

- **`mu sql` name errors teach the real name.** A guessed column offers the
  column that holds the data first: `name` on tasks -> `local_id, title` (it
  suggested `wave`), `body`/`text` -> `content`, `workstream` ->
  `workstream_id` plus the join that filters by workstream name, written with the query's
  alias for the table (`FROM tasks t` -> `t.workstream_id`). `no such
  table: x` (was passed through raw) is now a one-line `SqlTableError`
  (exit 2) naming the closest table (`notes` -> `task_notes`, `edges` ->
  `task_edges`) and listing every table and view.

- **Lease-carrier hints carry `-w`.** The `mu agent close <name>` hints of a
  refused stop, a spawn fenced by an unstopped or reserved job, and a dead
  remote worker in `mu task next --recover` now name the agent and
  `-w <ws>` (the refused stop printed a literal `<name>`), so they run
  outside the agent's own workstream.

- **A malformed CLOSE refusal names the shape it wanted.** Every
  `no close (malformed): <reason>` (the task note, `mu wait`, `mu agent
  collect`) now ends with the expected three lines, in one line: the
  `CLOSE: task=<id> evidence="<command + result>"` header, then `REPORT:`
  alone, then the report. The ctl close notice still prints them as lines.
  The grammar is unchanged (a close never happens by guess). The
  `remote-workers` and `worker` recipes show the block fenced, three lines,
  `REPORT:` alone: 45 of 48 remote refusals since Nov 1 were a blank line
  before `REPORT:` or text on it. `remote-workers` waits with `mu wait
  agent:<ws>/<n>@<runs>` (the spawn's next) instead of the pi-only `mu agent
  wait --after-runs`.

- **A remote worktree close waits out a brief holder and names a lasting
  one.** A process inside the parked tree is re-scanned once a second for
  up to 5 s inside the same leased exec (no second exec, no extra rename),
  so a short-lived tool no longer causes a refusal. One still there is refused as `process <pid> (<command, cut>,
  <age>s old) on <host> is still inside <path>; ...`, from the host's `ps`
  (the bare pid when `ps` cannot say). `--force` is unchanged: it neither
  waits nor refuses.

- **A local close no longer removes a tree under the agent's own pi.**
  `mu agent close` killed the pane and scanned for holders at once, but pi
  outlives the hangup while it saves its session and runs its exit hooks,
  so the close warned `process … (pi) was still inside …; the tree was
  removed under it`. The close now reads the pane's processes before the
  kill and waits up to 5 s for them to exit before it scans. On macOS
  (whose `ps` has no session id) those processes are the pane's
  descendants still on its terminal (or in its process group); before, only the pane's first
  process counted, so the preview listed the agent's own pi as a holder
  too. pi's helpers that outlive the hangup (a plugin that moves to its own
  process group and is reparented away from pi, its children, a
  `setsid`'d drain) are waited for in the same 5 s
  when they hold the tree: the close reads, before the kill, the process
  groups of the pane's session and of each descendant that left it. The
  5 s count from the kill and include the scans; the park, the holder scan
  and the removal follow (1.5 to 2.5 s on a Mac), so a helper that never
  exits gives a close of about 7 to 8 s. A helper still there at 5 s, and
  any foreign holder, is still named (or refuses, as a writer) as before. The preview's `--if` revision never
  depended on the holder list: two previews agree while those processes
  churn (now pinned by a test).

### Eval rig (not shipped)

- **Eval: markers from the rendered help** (task `f_help_markers`, spec
  revision 4). `deriveMarkers` also diffs `mu <path> --help` of every command
  path, base against variant: a help line the variant prints and base's help
  and corpus have nowhere is a marker; a base line the variant dropped is a
  context marker when base's help and skills hold it once. The source hunks
  missed what commander composes (`notes [options] [ids...]`) and literals
  whose escapes `dist/` spells otherwise, so C3's multi-id variant had no
  marker any help arm showed; it now has four, seen under `help` and
  `skill+help` only. Error text a lead-in prints reaches the model through the
  lead-in's output, which the golden diff already scores as a changed call.

- **Eval: help arms, a skill-text length cap, a publishable report, one C7
  base** (task `f_help_arm`, hill2 notes 32-33, spec revision 4). The probe
  gains the arms `help` and `skill+help`: the prompt also carries
  `mu <group> --help` and `mu <verb> --help` of every verb the lead-in spells,
  rendered live from the surface under test (16 000 chars at most; group
  entries drop first, and lint fails a case base would cut). A variant that
  changes only help text or adds a flag can now be exposed. Fast
  `plan|freeze` add both arms to every case (`--no-help-arms` keeps the
  case's own), and R1 runs the arms the freeze row's plan records.
  `nextstep check` also runs each golden under both arms. A changed string in
  skill or recipe text (`skills/**`, docs the skill links to) is capped at
  max(2x base, base + 200); src strings keep their cap, and the admission row
  counts the strings under each cap. `tournament report` writes the canary
  first and last (report and control copy), spells home `~`, defangs prose
  links and fences each patch past its own backtick runs, so the
  rig-guard, public-tree and doc-links tests pass on a generated report.
  `final --combined` takes one base: it lists every group's base and refuses
  a mixed set (or one off `--base <sha>`), and a base surface rebuilt at
  another sha. Every group must be (re)frozen on that one base.

- **Eval: fast mode's win threshold is data, and a full group can go fast**
  (task `f_fast_mode_2`, spec §4.7). `freeze --fast` and the new
  `migrate-fast` take `--win-alpha <a> --correct none|variants|bonferroni`
  (default: Bonferroni over variants × headline cases at family α 0.20, so z
  ≥ 2.13 at 6 × 2); the row records the rule, `decide --fast` computes z from
  the R1 field and writes it into the decision row. `migrate-fast <g> --why`
  switches a full-mode group whose R1 is scored (and R2 is not) to fast,
  keeping its epoch, so `decide --fast` reads that epoch's R1 rows with no
  re-run; a judges hash that moved since the freeze is listed file by file and
  needs `--accept-judges <hash>`. The fast report prints the rule and, by Monte
  Carlo at the group's R1 design and variants × headline cases, its per-group
  false-win rate (about 0.15) and power for 0.5 → 0.8.

- **Eval: tournament fast mode** (task `f_fast_mode`, user decision
  2026-11-09, spec §4.7). `tournament plan|freeze --fast` plans R1 at
  `n_eff` 30 per model and 45 pooled; `decide --fast <g>` decides on R1 rows
  (ahead of base on both weak models and pooled z ≥ 1.65; losses as in §4.1;
  at most one winner per group). R2 and the per-group R3, R4 and final refuse
  on a fast group. `final --combined` (C7) puts every group's winner on one
  surface, runs R4 with sonnet and both weak models, then the holdouts once,
  and on a regression bisects the winners on the R4 scenarios only and names
  the one to drop. The report states the accepted false-win rates (about 0.10
  per group, 0.47 over six) and the group's bound 1 − 0.95^(N·h), which
  Monte Carlo puts at 0.17-0.58 for 6-12 variants.

- **Eval: the AUT cannot read the rig** (task `f_aut_reads_rig`). In B5's R4
  rows 57 of 115 gemini runs read `tools/eval` (scenario and holdout sources,
  goldens, judges) through the faux workers' `-e <checkout>/tools/eval/faux.ts`
  in `.rt/pi`, the ssh shim's path, `ps`, and the surface's own `tools/eval`.
  The sandbox now runs copies under `.rt/lib`, `prepare` strips the rig from a
  surface, a pi AUT loads `aut-guard.ts` (refuses a tool call that names the
  rig, cuts rig lines from results), and `rig-guard.ts` marks any run that
  still reads it as a rig read: `verdict.rigReads`, never completed, out of
  R3/R4/final counts and ρ̂; a probe answer that names it is refused unrun.
  Since `f_aut_reads_rig_2`, every file under `tools/eval`, `test/eval`,
  `docs/eval` and `docs/specs` carries a canary token on its first and last
  line (`tools/eval/rig-private.ts`): a tool result, probe output or pane
  AUT's hook transcript that carries it is a rig read, whichever path got
  there (`cd` chains, globs, `git show HEAD:tools/eval/…`, symlinks). The
  guard also matches relative `tools/eval`, follows `cd`, normalises realpaths
  (`/private/tmp`), and covers the transcript stores, museum and mu state dir
  of the designer deny list (one shared list). Since `f_aut_reads_rig_3`, a
  judge-side fingerprint (`tools/eval/rig-fingerprint.ts`) catches the reads
  that skip a file's ends (`sed -n 5,15p`, `xargs grep -h`, `grep -rn` after a
  computed `cd`, `tar t` of the scenarios): an output that carries one of the
  rig's own names (ids, holdout ids, declared names; none of the surface's,
  the staged files', `node_modules`' or the run's env words) is a rig read,
  in pi tool results, probe outputs and pane AUT transcripts. K = 1, set by
  the B5 scan (0 legitimate hits). Encodings and plainly named listings stay
  open (README). 5 kept B5 gemini rows carried it (`ps` of the driver, a grep
  of the unstripped surface's `docs/eval`) and were re-run.

- **Eval: the hill-r2 tournament gate and report** (spec
  `docs/specs/2026-11-07-hill-r2-tournament.md` §4.4-§4.6, §5, §6, unit B3c).
  `tournament r3|r4|final|report` replace B3b's stubs. `tournament-r4.ts`
  runs every AUT job through one resumable runner (`runR4`) whose rows carry
  exposure, placed destructive entries and attribution; a verdict without
  `destructiveFx` sends its `destructive[]` entries to review as unplaced,
  never as clean. R3 picks the scenarios that exercise each finalist (golden
  markers, behaviour diff, live haiku exposure, up to 6); R4 tests completion
  per model with Holm, needs exposure on a weak model, eliminates on an
  attributable entry and stops (exit 7) on a new one; `final` runs the
  holdouts once on the combined surface with logs only under `sealed/`, and
  a holdout failure is a review stop, never bisected. `tournament-report.ts`
  writes the §6 report, states the power at the planned n (per-model n_eff 64,
  not the spec table's), that false wins are controlled per group (≤ 0.26 for
  one or more over six groups, holdouts no-regression only) and the
  end-to-end power to land a real 0.5 → 0.8 fix (~0.7), and copies the
  control file to the committed `docs/eval/hill-r2/<group>.tournament.jsonl`.

- **Eval: the hill-r2 tournament driver** (spec
  `docs/specs/2026-11-07-hill-r2-tournament.md` §3, §4.1-4.3, unit B3b).
  `node tools/eval/main.ts tournament freeze|refreeze|plan|pack|design|audit|build|r1|r2|review|status`
  runs a group's variants by successive halving. A variant is a patch on a
  copy of the built base (`tournament-build.ts`): the driver derives its
  markers, context markers and behaviour signature (new flag or verb names,
  golden diffs over a base noise mask) from the patch and admits it only when
  it is observable and inside the caps. `tournament-design.ts` packs base for
  the designers without the eval rig (scrubbing the files that name it),
  refuses a leaky BRIEF.md, launches each designer with an empty HOME and a
  PATH without `mu` or `museum`, and audits its session files: the catch-all
  lets node's install dir, the provider extension and what the pack itself
  says through, so an ordinary stack trace or a read of mu's docs does not
  discard a session. The audit resolves relative paths in what the designer
  did (bash commands, read and write paths) against the session's cwd, so
  `cat ../../../../../../../.pi/agent/sessions/x` from the pack is a hit.
  `tournament-score.ts` scores a round with the per-case Holm
  and stratified CMH losses and the pooled weak-model win test at 0.05/S,
  ranks by a total order, advances fixed counts, and stops for review (exit
  7) on a new unattributable destructive entry. `freeze` and `plan` print the
  plan's CMH power per model (at the default ρ 0.2: own headline r = 3, n_eff
  64 per model, 0.98 for a broad 0.8 → 0.7 drop, 0.53 for 0.8 → 0.75).

- **Eval: exposure-gated scoring for the hill-r2 tournament** (spec
  `docs/specs/2026-11-07-hill-r2-tournament.md` §4.1, §5, unit B3a).
  `tools/eval/exposure.ts` decides whether a probe row or an R4 run saw a
  variant's changed text or behaviour, and which destructive entries are
  attributable to it. Win clusters are chosen only by exposure fixed before
  the answer, never by the answer's own calls, so a null variant cannot win
  through cluster selection. `tools/eval/stats.ts` holds the tests: Fisher
  exact and its power, Holm, stratified CMH, ICC, DEFF and Kish scaling, and
  the n plan. `ToolCall` gains optional `turn` and `idx`; `Verdict` gains
  `destructiveFx` (each destructive entry placed at its tool call) and
  `muCalls`.

- **Eval: the next-step probe** (`tools/eval`, hill-r2 B2). `node
  tools/eval/main.ts nextstep run|check|lint|selftest|report` gives a model a
  live transcript ending in one mu output, a goal and an optional skill or
  recipe, runs its next one to three commands in the same sandbox, and judges
  the state and mu's own output (spec
  docs/specs/2026-11-07-hill-r2-tournament.md §1). Two pilot cases,
  `close_preview_apply` (bash) and `notes_multi` (zsh); `check` and `selftest`
  cost nothing. `cold-guess`'s `execGuess` takes a shell and an env, and
  `askModel` answers the scripted `evalfaux/*` models without pi. `main.ts`
  dispatches `tournament` to a stub until the driver lands.

- **Eval: the next-step case catalogue** (`tools/eval`, hill-r2 B4b, spec
  docs/specs/2026-11-07-hill-r2-tournament.md §2, §7). Eleven more cases
  beside the two pilots: close preview with an unmerged commit, three wait
  readings (result line, heartbeat merged into JSON, the 120 s shell limit),
  the delegate report in notes, agent read through pane chrome, NO VERDICT
  LINE, a worker that closed with the verb, sleep polling, and the sql and
  finding guards. `nextstep check` proves every §2.3 row on base, lint is
  clean against base's names. `dead_once` is dropped: base reports one death
  once. `shown` compares whole lines and each case-7 marker has its own
  nonce, so a `grep -o | sed` rename of another note's marker misses; cases
  1 and 2 allow only worker-1's agent ops; the timed rule counts the shim's
  own span (its table dumps) as time in mu, so a one-call answer on a loaded
  host is not read as idle; `check` asserts partial where §2.3 says so.
  B6 adds paraphrases where B5's ρ̂ left the plan short (spec §4.2):
  `close_preview_apply`, `close_preview_conflict`, `wait_result_read`,
  `notes_multi` and `agent_read_text` go to 14, the `sql_name_guess` guard
  to 13 (docs/eval/hill-r2/baseline.md, "B6").

- **Eval rig: hill-r2 fixtures, intents and R4 scenarios** (spec
  docs/specs/2026-11-07-hill-r2-tournament.md §2, §7 B4a). `tools/eval`
  fixtures gain gated task scripts (`gate: { delayMs }`, released by
  `<workers>/go`), `chromePane`, `seedDelegate` (a finished delegate call
  through the real writers) and `delegateDefault`. Cold-guess gains eight
  next-only headline intents for verbs since 4.0 (`check_record`,
  `verdict_record`, `wave_outcome`, `host_list`, `lease_show`, `notes_two`,
  `close_apply_clean`, `report_only`); three R4 scenarios judge sleep and
  poll waits (`poll_wave`), one note summarising four reports
  (`multi_notes`) and acting on a worker's result read through mu
  (`wait_report_act`). `cold-guess check --family next` is green again:
  a sandbox copies pi's cached model catalog so a nested worker pi
  starts, the remote gate seed spawns as pi,
  and `task_brief` is reworded. The faux worker reads its claim with a
  plain `sqlite3` connection: `-readonly` cannot open the WAL DB once no mu
  process holds its -shm file, so a worker whose orchestrator slept gave up.

- **Eval rig: every row runs under its own muzzle claim; the load gate is
  gone; the mu shim is cheap** (task `f_eval_muzzle`, after eval runs drove
  the mac to load ~250 on 2026-11-08). One run fanned out to 24 sandboxes
  under a single 3-slot `mu-eval` claim, and the 1-min loadavg gate let all
  24 start inside one stale minute. Now a probe row, an AUT run, a
  cold-guess guess and a designer session each hold `muzzle run --rule
  mu-eval-<kind> --slots <w>` while they run (`tools/eval/claim.ts`;
  `EVAL_ROW_SLOTS_<KIND>` overrides w), `--concurrency` is capped to
  `floor(budget / w)`, and a rig that itself runs inside a muzzle claim takes
  no per-row claims and runs `floor(outer slots / w)` rows. The outer claim
  is found as muzzle finds it (`MUZZLE_SLOTS`, or a live holder in the rig's
  ancestry: pi's muzzle extension sets neither `MUZZLE_SLOTS` nor
  `MUZZLE_HOLD`), and the first row's holder is checked in `muzzle status
  --json`; one that holds no slots drops the run to a low fixed cap (2 probe
  rows, 1 AUT run) with a warning. No muzzle on PATH, or a failing `muzzle
  status`, gives the same low cap, never the budget-derived 22. `run`,
  `selftest`, `check --preflight` and `tournament build`'s golden traces
  claim too, and `createSandbox` refuses to run outside a row claim.
  `tournament r1|r2` default to `--concurrency auto` (the budget cap), not
  24 (task `f_eval_muzzle_2`). `--max-load` is
  removed (`nextstep run`, `tournament r1|r2`). The sandbox mu shim's AUT
  call spawned 69 processes on macOS (4 perl clocks, 12 sqlite3 dumps with
  their cksum and cut); it now spawns 4: one sqlite3 call before mu and one
  after, each reading the clock and a `sha3_query` hash per machine-local
  table. A worker's call drops from 11 to 3 (1 on bash 5).

- **Eval rig: launcher variables come from `EVAL_LAUNCHER_ENV`** (public
  audit). The rig no longer names any launcher's variables: it sets
  each `NAME=VALUE` pair in `EVAL_LAUNCHER_ENV` for every pi it starts (a
  caller value of `NAME` wins), and seeds any `[<name>-]model-catalog*.json`
  cache. The pairs never override the sandbox's own `HOME`, `PATH` or `MU_*`
  (model, designer and scenario env alike). Run from inside a launcher's
  sandbox, set the pair that keeps the outer sandbox. Docs, fixtures and the
  README screenshot drop internal host, user and tool names. The designer
  isolation audit takes the museum checkout from `EVAL_MUSEUM_DIR` (no
  default) and denies any dir named `museum` holding `skills/museum`.

- **Eval: audit and judge gaps from the B3/B4 reviews** (f_low_batch3). The
  designer audit sees a search behind a wrapper (`sudo find /`, `env … timeout
  5 rg x /`) and a glob above HOME (`du -sh /Users/*` names `/Users`), and never
  allows an install dir that is HOME or a top-level child of it (a bin link into
  `~/bin`). The next-step judge counts a `| jq .` rendering as shown, caps a
  shim span at 5 s past its call, and fails an answer that names the shim's
  logs (`mu-shim.log`, `mu-calls.log`, `$EVAL_WORKER_DIR`). The R4 tests pin the
  per-cell new-vs-base check and the half-exposed threshold;
  `tournament-r4.test.ts` is split in two (shared fixtures in
  `test/eval/_r4-fixtures.ts`). The report says the end-to-end figure is
  computed from the null false-loss bounds, and rig-guard's canary test prints
  the exact line a file lacks.

- **No home paths in tracked files.** `docs/eval/hill-r2/baseline.md` had
  regained an absolute home path from an older branch; it now reads `~/`.
  `test/public-tree.test.ts` scans every tracked text file and fails on a
  real `/Users/<name>/` or `/home/<name>/` path, or on a term from an
  optional local list.

- **Eval: `tournament pack` drops a rig entry from a JSON config list**
  (hill-r2 c2). `tsconfig.test.json` names `tools/eval/pi-ai.d.ts` in its
  `include` since f_eval_muzzle_2, and the pack refused base `d9acd750`
  outright ("pack still carries denied text"). A string in a JSON array
  that names the rig is now removed; any other hit in a JSON file is still
  reported and refuses the pack.

- **Eval: the behaviour diff masks timing noise and data keys** (hill-r2
  c2). A call family the two base runs disagree on (in how often it ran or
  in any output: a poll while workers finish) compares on exit and JSON
  shape only; JSON object keys are normalised (a cursor keyed by a ref with a
  nonce); `normalise` also covers UUIDs, 6-character hex, a hex id glued to
  a name (`delegate_rev_3b9f1ea2`) and upper-case check ids. On c2's cached
  goldens the changed calls of every variant fell from five or six keys to
  the close calls each one really changes.

- **Eval: the tournament build trusts only complete golden passes**
  (hill-r2 c2 review). A base golden pass that was cut short (not ok) is no
  evidence of noise: such a case masks nothing, is compared against the
  complete pass if there is one, and the build lists it. The trace caches
  (`golden-base-<key>.json`, `golden-<id>-<key>.json`) are keyed by build
  ref, judges hash and the scenario and golden files, so a refreeze never
  reuses stale traces. A variant whose golden pass threw reports
  `goldenCompat not run` and is refused ("golden pass not run"). The
  parallel passes now run through `passPool`, tested to keep per-row claims
  and the serial traces.

- **Eval: a variant's new flag split over two lines is a new name**
  (hill-r2 c2). `newNames` matched `.option("--x"` on one added line, but
  the formatter writes `.option(` and the flag on separate lines, so c2's
  `--if-clean` and `--auto` had no behaviour signature. Runs of added lines
  are now joined before matching.

- **Eval: the behaviour diff pairs golden calls by occurrence, not
  position** (hill-r2 c2). Workers interleave their calls differently from
  run to run (`wait_mixed_refs` claims in either order), and one swap shifted
  every later pair, so all c2 variants carried a dozen unrelated changed
  calls (`task claim|--for`, `wait|--json,--timeout`, ...). Calls now pair
  by their k-th occurrence of the same normalised argv; an occurrence the
  two base runs disagree on is chance. `build` caches each variant's golden
  traces per build ref, and `--force` re-assesses from them.

- **Eval: a probe seed that fails on a surface gives an invalid row**
  (hill-r2 c2). Seeds are spelled in base grammar; a c2 variant that made a
  bare `agent close --json` apply the close broke the seed's revision read,
  and the throw crashed `tournament build` (and would have dropped the rows
  in R1 instead of scoring them). `playCase` now marks the row invalid
  (`seed invalid: …`), scored like a failed lead-in (spec §1.4 lint 3: an
  invalid headline row eliminates), and a variant's failed golden pass no
  longer stops `build` for the others.

- **Eval: `tournament build` runs its golden passes side by side**
  (hill-r2 c2). Base's two passes and up to `--passes` (default 4) variant
  passes run at once; each row still takes its own muzzle claim and rows are
  appended in candidate order. Serial, c2's eight variants took about 12 h
  of zero-cost goldens before R1 could start.

- **Eval: the designer audit no longer reads `//` as a search of `/`**
  (hill-r2 c2). A `//` comment inside a heredoc (a python script that edits
  TypeScript) was a strict path `//`, so the root, and discarded the
  claude-opus designer session on three false "search above HOME" hits. A
  slash-only word is now treated like a bare `/`: a hit only as the start
  dir of a search (`rg x //`) or a `cd`.

- **Eval: `tournament plan` plans from B5's rows before a freeze, and model
  errors stay out of ρ̂** (hill-r2 B5). `plan <g> --b5 <probe.jsonl>
  [--b5-cold <cold.jsonl>]` computes ρ̂ the way `freeze` does
  (`rhoFromB5`, shared by both), without writing a setup row. A row with a
  model error is rig noise, not a reading outcome; counted as a miss it
  faked a cluster effect.

- **Eval: the next-step probe counts a field of mu's tab-separated text as a
  whole line** (hill-r2 B5). `task notes` prints
  `<kind>\t<n>\tby=…\tat=…\t<text>`, so a note's first line was never a whole
  line once an answer cut the header (`awk -F'\t'`, `cut -f5-`), and
  `notes_report_read` scored 174 of 360 base rows a miss on finding 1 alone.
  A field is mu's own unit, as a jq -r string is; a `grep -o` cut inside it
  still does not count.

- **Eval: R4 scenarios run on macOS** (hill-r2 B5). `fanout_gates`'s commit
  hook stamped `date +%s%3N`, which BSD date prints as `<s>3N`: no merge was
  ever seen and its golden failed. Four bad scripts used GNU `sed -i '1i …'`
  (now `perl -pi`). `no_mux_delegate` seeded tasks into a workstream it never
  created. `refute_verdicts`'s delegate now holds its answer 3 s, so a close
  issued right after the call precedes the verdict (that bad passed). The
  README says to run on macOS with `TMPDIR=/private/tmp` (the `/tmp` symlink
  breaks the remote scenarios' path judges) and that `wait_interrupted` needs
  Linux.

## [4.5.0] — 2026-11-07

Every agent CLI is first-class: claude, codex, cursor-agent and Muse Code
orchestrate and work as well as pi does. Their panes report through
murmur's hooks, so **hook harnesses need murmur 2.0** (`npm i -g
@mu-crew/murmur@2`, then `murmur init`); pi alone keeps working with
murmur 1.x.

### Added

- **`mu doctor` checks mu's own hook entries** (spec D13). A new `hooks`
  section (and `hooks` in `--json`) reads claude's, codex's and
  cursor-agent's hook config through `mu init`'s own matcher and reports, per
  harness set up here, a missing `mu hook stop` entry, a drifted one (an
  older form, a changed timeout, a duplicate: what `init` would change), or a
  foreign one (an entry mu did not write that runs `mu hook stop`, which
  `init` leaves alone). Warn rows: doctor still exits 0. Read-only.

- **The prompts as skills for Claude Code and cursor-agent** (spec U19).
  `mu init` now also writes each shipped prompt (`prompts/*.md`, pi's
  `/ultrathink`, `/mu-review`, …) as a skill of the same name beside mu's
  skill: `~/.claude/skills/mu-review`, and cursor-agent's own copies only
  while Claude Code's directory holds none. The user starts one by name
  (`/mu-review <target>`). Every copy carries `disable-model-invocation`,
  which both honour, so the model never starts a crew on its own. Codex gets
  none: it has no verified way to keep a skill from its model, and one picked
  by its description would start a crew unasked. The argument pi substitutes
  for `$@` is named in words, since only claude substitutes one. The copies
  follow the skill's rules: a `.mu-init` marker, only an unedited copy of its
  own replaced, anything else kept, never pi's skill directories; an unedited
  copy of a prompt this mu no longer ships is removed. A prompt mu cannot
  read is refused alone (exit 1), and the others are still written. `--json`
  gains `prompts`; the text output prints one line per harness, state and
  detail. Muse Code installs skills with its own tooling, and pi keeps the
  package's commands.

- **`mu init`: mu's hook entries and skill for every hook harness** (spec
  D13, D17, U23). It adds `mu hook stop <harness> --timeout 600 || true`
  (with the entry's own 600 s timeout) on the stop event of
  `~/.claude/settings.json`, `~/.codex/hooks.json` and `~/.cursor/hooks.json`
  (cursor's own `loop_limit` on stop follow-ups is lifted: mu caps its blocks
  with `MU_KEEP_DRIVING_MAX`), and copies `skills/mu` to
  `~/.claude/skills/mu`, `~/.codex/skills/mu` and `~/.cursor/skills/mu`, for
  each harness set up here (`--harness <names>|all` writes the rest). The files
  are shared, so it touches only entries and copies it wrote: other handlers,
  groups and keys stay in place, an entry mu did not write that already runs
  `mu hook stop` is left alone and mu keeps none of its own beside it, a skill
  without mu's marker (a symlink included) or edited since is kept, and an
  unreadable file is refused
  (exit 1). A second run changes nothing. Muse Code gets no entry (its stop
  block drops the reason) and installs skills through its own tooling; pi
  keeps the package. It never writes into `~/.agents/skills` or
  `~/.pi/agent/skills`, which pi also reads, and refuses a skill directory
  that resolves into one, so pi still lists exactly one `mu` skill. An old
  `npx skills add mu-crew/mu` install in `~/.agents/skills` is left in place
  and named in the output: remove it, or pi lists two.
  cursor-agent, which also reads Claude Code's and Codex's skill directories,
  gets its own copy only while neither holds one. `MU_INIT_HOME` redirects the
  home directory. The harness table now records codex's and cursor-agent's
  skill directories, read from their installed builds.

- **The `hooks` channel: paste to claude, codex, cursor-agent and muse on
  tmux** (spec D4, U8). A local pane of one of those harnesses on tmux is now
  spawned on channel `hooks` (`agents.channel`). `mu agent send` to it reads
  `murmur pane <pane> --json` (which drains the harness's hook events first),
  refuses a `blocked` agent (`AgentSendGateError`, exit 4: answer the dialog)
  and, without `--force`, a running one or one whose state is unknown (no
  murmur row or no agent row, murmur silent, a crashed harness, or running
  with no event for `MU_STALE_MS`, default 10 min). The gate reads murmur's
  `attention` and the agent row's `activity`, not its rendered word, in which
  an old `error` outranks a running turn or an open dialog. Then it clears the input line with the
  harness's clear key (`C-u`: an interrupted claude puts its prompt back in
  the box), pastes once through a named tmux buffer, presses Enter, and
  confirms the send when `run_count` rises within `MU_SEND_ACK_MS` (default
  10 s): `ack: confirmed` with `runCount`, else `ack: unknown`
  (`delivered: false`, reason `unconfirmed`), never resent. `--steer` is
  refused (`AgentSteerUnsupportedError`, exit 2). pi, and
  every other CLI on tmux, are unchanged. VISION §6 now says so. `mu task
  claim --for` a `hooks` owner on tmux offers the plain `mu agent send` next.
- **Interrupt, abort, fresh, settle and last text on `hooks`** (spec D4,
  U9). `mu agent send --interrupt` and `mu agent abort` press the harness's
  interrupt key (Escape) on a running or blocked agent; a stopped one gets no
  key. codex and muse confirm the stop with their `Interrupt` event,
  cursor-agent with an aborted `stop` (none within `--timeout`:
  `AgentAbortTimeoutError`, exit 5, the text not sent). claude reports none,
  so mu writes `interrupted` through `murmur hook mu`, which murmur reads as
  `idle?` until the harness's next event; `idle?` is sendable, and if the
  Escape only closed an overlay the paste reads `ack: unknown`. If murmur
  will not record that event, the verb fails
  (`AgentInterruptUnrecordedError`, exit 5) and an interrupt's text is not
  sent. The result
  says which (`stopped: confirmed | unconfirmed`); an unconfirmed abort is not
  `settled`. `--fresh` pastes the harness's fresh command (`/clear`, `/new`,
  `/new-chat`; `--force` stops a running turn first): claude's text waits for
  the new session's `SessionStart` and is not sent without it
  (`AgentFreshUnconfirmedError`, exit 5); codex and muse start their session
  on the first prompt, so the text follows at once and is confirmed only by a
  run in a new session. A wait on a `hooks` agent now watches it: it settles
  on the pane's `turn_stopped` past the baseline (a running agent's baseline
  counts only settled turns) and returns that turn's text, with
  `lastTextTruncated` at murmur's 64 KB cap. murmur names the run whose turn
  wrote its last text (`last_text_run`), so the text counts when that run is
  the settled turn's, however late the wait first reads it and whatever an
  earlier turn wrote; a turn ended by an interrupt or a failure (which leaves
  an earlier turn's text) and an `idle?` turn carry none, and apply no
  `CLOSE:` block (a failure carries its error). An older murmur names no run:
  then the text counts only when it changed since a read taken before the
  turn ended, so a text equal to the previous turn's and a wait that first
  reads the turn already over carry none as well. cursor-agent's text, which
  can follow its `stop`, is awaited for up to 3 s. A dialog ends the wait as its `input` event (blocked on a dialog),
  as on pi. A confirmed paste fences the wait it arms
  (`afterRuns` = its `run_count` less one, the session as incarnation), so
  `send --wait` and the next hint wait for exactly that turn, and its `CLOSE:`
  block is applied once per session and turn, with the trust of pi's ctl
  text (spec D3). pi is unchanged.
- **The pi fallback: `MU_PI_CHANNEL=hooks`** (spec D15, U13). `mu agent
  spawn` of a local pi on tmux with `MU_PI_CHANNEL=hooks` in the caller's
  environment records channel `hooks` on the agents row and hands the pane
  the variable, so murmur's pi extension writes inbox events instead of
  opening its store (for a pi build that breaks the store or a native module;
  not one that loads no extensions). Every verb then follows the row:
  send, interrupt, abort, fresh (`/new`, confirmed by its `session_start`),
  settle, last text and answer go through `hooks`, with pi's clear key
  (`C-u`) and no interrupt event of its own (`idle?`, as claude). mu's pi
  extension still serves its control socket, for the spawn handshake,
  delegates and `mu doctor`'s ctl row only. `mu agent check` now asks the
  row's channel, so it never probes that socket. The contract suite runs
  against pi on `hooks` and asserts no verb reaches ctl. Only `hooks`
  selects the fallback; unset or anything else, and for a remote pi or a pi
  on herdr or Rex, pi stays on ctl, unchanged. A ctl pi's pane pins the
  variable empty, so a tmux server a fallback spawn started never hands it
  `hooks`. A task-bound spawn hands it the brief as every `hooks` worker
  gets one (a brief file and a pasted pointer). `mu doctor` no
  longer reports murmur as not needed while a pi runs on the fallback.
- **Task briefs for `hooks` workers: a brief file and a one-line pointer**
  (spec D17, U20). `mu agent spawn --task` (and `mu task auto`) now hands a
  local claude, codex, cursor-agent or muse worker on tmux, or a pi on the
  fallback, its brief inside the same journaled attempt (reserve, pane,
  claim, `sending`, write, sent). The worker is launched with no prompt. After
  the claim mu waits up to `MU_SPAWN_ACK_MS` (default 30 s) for its
  `session_start` in murmur's inbox (codex and muse report a session only
  with their first prompt, so they are read once, never waited for), writes
  the brief to `<cwd>/.mu/brief-<agent>-<attempt key>.md` with
  `.mu/.gitignore` = `*` (the worktree stays clean), journals `sending` with
  the session and `run_count` it read, and pastes one line telling the worker
  to read the file, confirmed by `run_count`. An unconfirmed paste is
  `unknown`, pane and claim kept, never resent; a replay of the attempt reads
  the inbox and promotes it to `sent` (pinning the brief) once a run past that
  baseline shows. A dialog at the paste is refused and rolled back.
  `spawn_receipts.transport` takes `hooks` (a v13 file's table is rebuilt in
  place, rows kept).
- **The executor on `hooks`** (spec D17, U22). `mu task auto --cli claude`
  (or codex, cursor-agent, muse) dispatches through the brief file and its
  pointer, and `mu next` now recovers such a worker. One whose last turn
  ended in `turn_failed` (claude's `StopFailure`, cursor-agent's error
  `stop`), with nothing in the pane since, is retried in place once per
  failure, up to the run ceiling as on ctl: one run charged, the stored brief
  written to the retry attempt's brief file and its pointer pasted again into
  the same pane, the harness `session_id` standing in for pi's incarnation
  and the `run_count` read before the paste going into `receipt.runs`. murmur
  keeps an `error` through later turns and keeps its first time on a repeat,
  so only an error raised by the pane's newest event counts, and the retry
  first clears the one it answers (`murmur clear --pane`, with `-L` naming a
  private `MU_TMUX_SOCKET` as `murmur pane` is read, plain for a murmur too
  old to take it; confirmed by a read): each later failure is raised afresh. One murmur could not clear is
  an `attention` move, nothing charged. A failure in another session than the
  brief's is an `attention` move. On muse, whose `StopFailure` murmur maps
  but whose `turn_failed` row is unverified (and pi on the fallback), a
  failed turn parks the attempt `needs_human`, its human need naming the
  failed turn. codex reports no failed turn at all (murmur writes no
  `turn_failed` for it), so a failed codex turn is neither retried nor
  parked. An unconfirmed `hooks` attempt is now resumed through the inbox
  (promoted to `sent` once its run shows) instead of parked unasked. Charging
  is unchanged. `murmur pane --json`'s attention `requested_at` is read as
  `errorAt`.
- **Remote mixed crews: host capabilities and remote task briefs** (spec D17,
  U21). `mu host check` now probes each harness's literal launcher
  (`claude`, `codex`, `cursor-agent`, `muse`, `pi`) by name in the profile's
  own shell mode (a session's login shell, a lease job's bare `sh -c`, which
  reads no rc files), and reads each hook harness's config for murmur's
  `murmur hook <harness>` entries (missing: the new `hooks` step fails) and
  mu's `mu hook stop` entry (missing: a warning). A `harnesses` step lists
  what it found and fails only when it found none. The pi and `extension`
  steps run only on a host with pi, so a claude-only host passes. The result
  and its probe time are recorded in a new `host_profiles.capabilities`
  column (added in place at schema 13), shown by `host show`, a `HARNESSES`
  column in `host list` and the `--json` records. A spawn whose command is a
  harness the record says the host lacks is refused before any effect
  (`HostHarnessMissingError`, exit 2, naming host and harness); a host never
  checked, or a wrapper command, is not. `spawn --task` of a remote claude,
  codex, cursor-agent or muse worker now hands it its brief: mu reads the
  host until the worker reports its session, writes
  `<remote cwd>/.mu/brief-<agent>-<attempt key>.md` and `.mu/.gitignore`
  through one `--exec` with the brief as one argument, and pastes the
  one-line pointer (`sent`, confirmed by the next read). Exec templates have
  no stdin, so a brief over 96 KB (its `\` and `'` counted escaped) is
  refused before anything is spawned (`RemoteBriefTooLargeError`, exit 2),
  executor attempts included. On `--host`, a `--command` whose argv0
  is a harness, or a `--cli` key that maps to one (`claude-big`), is a worker,
  not a command gate. pi is unchanged, except that a host checked without pi
  now refuses a pi spawn.
- **Spawn presets and `--model`** (spec D6, D17). `mu agent spawn --model
  <id>` passes the model through the harness's own flag (`--model`, pi
  included). A worker of claude, codex, cursor-agent or muse launched from
  its cli key or `MU_<KEY>_COMMAND` (not a literal `--command`, not an
  orchestrator) gets its auto-approve flags
  (`--permission-mode acceptEdits`, codex
  `--dangerously-bypass-approvals-and-sandbox`, `--sandbox enabled`,
  `--approval-mode never`), all skipped when the
  command already picks an approval or sandbox mode (any alias, `=` form or
  conflicting mode, such as codex `--sandbox=read-only` or `--yolo`); pi
  gets none. A `--worktree` spawn adds the trust flag for the
  worktree mu made (codex `-c 'projects={"<realpath>"={trust_level="trusted"}}'`,
  cursor-agent `--trust`, muse `--trust-workspace`). A codex worker
  therefore runs with no codex sandbox and no approvals on every machine,
  remote ones included: codex's seatbelt cannot start under a launcher that
  already sandboxes it, and mu cannot detect one; `MU_CODEX_COMMAND='codex -s
  workspace-write -a never'` keeps codex's sandbox where it works. The agents row keeps
  the command as given. `--model` on a remote command gate, or for a CLI
  outside the five, is refused.
- **`mu agent list` names each agent's harness and channel**: a `harness`
  and a `channel` column in the table, and `channel` (the agents column) and
  `harness` (computed: argv0, then the cli key and its prefix; null outside
  the five) in every `--json` agent record.
- **`mu agent answer <name> <choice...>`**: type a pending permission
  dialog's answer into the pane (text literally; `Enter`, `Escape`, `Tab`,
  `Space` and arrows as keys). On `hooks` it is refused unless murmur reads
  the agent blocked (`AgentNotBlockedError`, exit 4; `--force` types anyway)
  and confirmed by the next hook event. With no event within
  `MU_SEND_ACK_MS` it writes `continued` through `murmur hook mu --pane`, so
  the answered dialog stops reading `blocked`; a pi agent's dialog is answered in
  its pane (`AgentAnswerUnsupportedError`, exit 2). Recorded as an
  `agent.send` op with `mode=answer`.
- **`MuxBackend.pasteToPane` and `sendKeys`** (tmux only): clear key, one
  bracketed paste (chunked `set-buffer -a` under tmux's 16 KiB message cap,
  deleted by the paste, deleted on failure), Enter; and keys as names or
  literal text. A word ending in `;` goes out as `\;` (`tmuxWord`): tmux
  splits its argv on a final `;` before parsing, so a prompt ending in `;`
  would lose it.

- **`mu orchestrate -w <ws> [--cli <key>]`**: start an orchestrator of any
  agent CLI as a managed pane, with an explicit identity (caller
  `<ws>/<name>`, default `orchestrator-1`, else the next free one). Its pane
  gets `MU_ORCHESTRATOR=1`: a pi orchestrator keeps `mu_delegate` (the gate is
  now "hidden under `MU_MANAGED_AGENT` unless `MU_ORCHESTRATOR=1`"; VISION key
  constraint 3), and it gets none of a worker's extras: no close nudge, no
  implicit `-w`. The flag never reaches a helper: spawn builds every pane's
  env, a mux-free delegate's child pi has it removed, and it joins
  `LOCAL_ONLY_ENV`. Third unit of the every-harness-first-class spec (D9).
- **`MU_AGENT_CLI`** in every local agent pane: the harness it runs
  (`claude`, `codex`, `cursor-agent`, `muse`, `pi`, mapped from the command's
  argv0, else the cli key and its prefix), else the cli key.
- **Anchors.** A local `claude`, `codex`, `cursor-agent` or `muse` pane on
  tmux starts through a small `sh` wrapper that writes
  `~/.local/state/mu-next/anchors/<pid>.json` (agent, workstream, role,
  harness, orchestrator flag, remote key, `ps` start time; there alone,
  whatever `$XDG_STATE_HOME` says, since murmur reads that path first) and
  then `exec`s the command
  in `$SHELL`, as tmux ran it before, so a hook whose harness clears its env
  finds the agent (murmur's reader, spec D3). pi panes, and herdr and Rex
  panes, start unwrapped; the agent row keeps the command as given. A dead
  pid's anchor is pruned at the next spawn.
- **`--as <caller>`** on `mu wait`, `mu state` and `mu next`: a process with no
  managed env (a harness's Stop hook, a script) names its caller,
  `<ws>/<agent>` or `pi:<session>`. A wait `--as` a caller another live
  process already waits as is refused (`CallerBusyError`, exit 4); every wait
  marks its callers under `<state>/waiters/` while it runs, and a dead or
  reused pid's mark is ignored. An `--as` wait marks first and checks after,
  so two started together never both run. `mu next --as` refuses only with
  `--hold`.

- **Queued is not stalled** (spec D14). An agent off ctl whose pane holds a
  `muzzle run` waiting for slots fires no hook events while it waits. mu now
  asks `muzzle status --json` (muzzle with waiter `pid`s, cached 5 s; nothing
  when muzzle is absent or nothing waits) and places each waiter by its
  process tree under the agent's pane. Such an agent reads `queued: true`
  (its agent `--json` record, its state with `(queued in muzzle)` in
  `mu agent list`, distinct from a delegate call's `queued` state), a
  wait never reports its task stalled, and the dashboard raises no `input`
  or `stalled` item for it. pi agents are never looked up.

- **`mu hook stop <harness>`: keep-driving and the close nudge for claude,
  codex and cursor-agent** (spec D7, U10). A Stop hook entry (`mu init`
  writes it; see `docs/guide/other-agent-clis.md`) that reads the
  harness's Stop payload on stdin. It acts only for a pane agent mu started:
  it walks its process chain to the first anchor with a matching start time
  whose cli is the hook's harness, refusing a second harness on the way or a
  one-shot one (`claude -p`, `codex exec`, `e` or `review`, read as murmur
  reads them, so a prompt holding the word `exec` is no subcommand: U0 saw
  codex's and muse's directly under the parent's binary), a remote anchor, and, with nothing anchored, a
  managed env whose `MU_AGENT_CLI` names another harness. For an orchestrator
  (`mu orchestrate`), a live process already waiting as its caller lets the
  turn end; otherwise it runs a consuming `mu wait --first --timeout <T> --as
  <caller>` (T is `--timeout`, the entry's own timeout, default 600, less
  10 s): an event blocks the stop with the wait's result under the SKILL.md
  keep-driving rule; a timeout with work still owed blocks with "run `mu wait`
  in the background", at most `MU_KEEP_DRIVING_MAX` (default 20) times in a
  row; nothing owed lets it end. A worker still owning an IN_PROGRESS task is
  told once per session to close it or say why not. Every block writes
  `continued` through `murmur hook mu`. The answer is claude's and codex's
  `{"decision":"block","reason":…}` or cursor-agent's `followup_message`;
  nothing lets the turn end, and the verb always exits 0, even for a malformed
  entry (a bad `--timeout` means 600, an unknown option is ignored): claude and
  codex read exit 2 as a block (`--json` prints the decision as an envelope). codex's title-generation Stop and cursor-agent's
  aborted or failed stop are let go. Muse Code always passes: its block does
  not deliver the reason. `MU_NUDGE=0` turns it off. pi is unchanged.
- **Recorded checks: `mu task check` and `mu task verdict`** (spec D5, U11).
  An orchestrator that checks a finding with a native subagent or a
  cross-family pane records it: `mu task check <id> --by <harness>[/<model>]
  --brief -` stores the brief and prints `check=<id>` (a ULID, so two synced
  machines never collide); `mu task verdict <id> --check <id> -` stores the
  `VERDICT: CONFIRMED | REFUTED | UNVERIFIED` line and its `EVIDENCE:` lines
  (no VERDICT line: `CheckArgError`, exit 2; a check of another task:
  `CheckNotFoundError`, exit 3; the same verdict again writes nothing, a
  different one replaces it). `mu state` lists every check of a workstream
  that has no verdict (`checks`, whoever issued it), so the orchestrator that
  replaces a killed one sees which checks were issued and which were lost.
  `mu task close --if-ready` now waits until every blocker is CLOSED **and**
  every check on them has a verdict; a skip lists them in `pendingChecks`.
  `mu_delegate`, delegate calls and `next --refute` are unchanged.
- **Remote hook harness workers on `hooks`** (spec D11, U12). `mu agent
  spawn --host` of claude, codex, cursor-agent or muse (from a tmux origin)
  now records channel `hooks` and a per-spawn remote key,
  `<origin host>/<ws>.<agent>.<nonce>` (`agents.remote_key`). The remote
  command starts through the anchor wrapper, which writes the anchor, key
  included, under the remote `$HOME`, and `{env}` also carries `MU_AGENT_CLI`
  and `MU_REMOTE_KEY` (both unset for the local transport pane). The
  worker's hooks on that node write to murmur's remote area, so the node's
  store and `murmur status` never list it. mu reads that area with `murmur
  pane --remote <key> --json` through the profile's `exec` template, under
  the host's channel admission, and relays each event it applied into the
  local pane's inbox with `murmur hook mu --pane` (harness and agent named).
  It reads only on a send gate (send, a session command, `--interrupt`,
  abort, answer), at the start of a wait's watch and every 5th poll after,
  and on collect; never in an ack poll. So a remote send returns `ack: sent`
  (fenced by the run count the gate read) and the next read confirms it. A
  node that cannot be read (a busy host at `--max-sessions 1`: the worker's
  pane holds the only channel) makes the gate read `unknown`; `--force`
  pastes anyway. `--interrupt` and abort press Escape. A harness that
  reports its own interrupt (codex, muse, cursor-agent) is read first: that
  interrupt, relayed as the harness's (`murmur hook mu --by harness`, where
  the local murmur takes it), is `stopped: confirmed` and mu records nothing.
  Otherwise mu records `interrupted` on the node and reads it back in one
  exec (`stopped: unconfirmed`, `idle?`); a node that will not record it is
  `AgentInterruptUnrecordedError` and the text is not sent. Every event the
  harness itself reported is relayed `--by harness`, so the origin pane reads
  it as the node did; a murmur that refuses `--by` gets it as mu's, as
  before. collect ties the node's text to its turn by the node's
  `last_text_run` where its murmur reports one, else by mu's own record. `answer` records
  `continued` on the node before typing the keys (`ack: unknown`), and puts
  the dialog back there when the keys never reach the pane. `--fresh`
  is refused (`AgentSendUnsupportedError`): its new session is confirmed only
  by polling. Events the node applied that never reached the local pane (an
  exec that timed out, a relay murmur refused) are not lost for good: every
  read that succeeds compares the local pane with the node's report and
  writes the events that bring it back in line. A wait on a worker whose
  local pane has no row yet (just spawned, or its node not yet readable)
  reads the node every few polls until one appears, from the spawn's
  baseline. `mu agent collect` on such a worker, once its commits are
  pinned, reads the node and applies the `CLOSE:` block of its last ended
  turn (`close: {applied, task, reason}`), once per session and turn, as `mu
  wait` does, and only when that turn wrote the text: mu counts which run
  each relayed text arrived in (a small record per key beside the DB's
  locks), so a turn that failed, was interrupted or ended without text never
  applies an earlier turn's block. A remote pi worker is unchanged (ctl, no key, no anchor). A
  check against a live host is still owed: the tests drive a fake node
  through a fake exec template.
- **Evals on every harness: cases E1–E7 and the rig for them** (spec U24).
  `tools/eval` gains `--harness pi|claude|codex` on `run`, `matrix` and
  `check`: a claude or codex orchestrator runs in a pane started with `mu
  orchestrate`, prompted through mu's hooks send and settled by murmur's view
  of its pane; pi keeps its rpc runner. Seven `next`-only cases mix worker
  harnesses per case: E1 dispatch and merge (claude, codex), E2 finding
  triage with a cross-family refuter, E3 review gate, E4 crash and
  replacement orchestrator, E5 remote worker (claude on the ssh shim host),
  E6 interrupt and resend, E7 a mixed crew (local codex and pi, remote claude
  and pi). Each has a written pass criterion as its judge, read from effects
  (ops, `runs.log`, git, and a new observer hook's `hooks.log`), and a golden
  plus at least three bads, proven at zero model cost by `check` with fake
  claude, codex, cursor-agent and Muse Code binaries that read their pane
  and fire the real ones' hooks with the U0 payload keys, and on synthetic
  end states in `test/eval/harness-judges.test.ts`. The rig's hook entries
  run the worktree builds of mu, murmur (`EVAL_MURMUR`) and muzzle
  (`EVAL_MUZZLE`) by absolute path from project files committed in the
  sandbox repo, which also carries the surface's skill as claude's project
  skill; codex's global `hooks.json` is backed up and restored around a
  live run, shared by the sandboxes of one process (or
  `EVAL_CODEX_HOOKS=codex-home`, which also gives codex the surface's skill).
  A live run keeps the user's HOME and auth; the ssh host keeps its own HOME
  with links to the harnesses' config, so mu's remote worktrees stay in the
  sandbox. [docs/eval/every-harness.md](../eval/every-harness.md) lists
  exactly what a live run changes, which skill each orchestrator reads, that
  no token budget bounds it, the commands per case and the empty results
  tables. The rig also runs on macOS now: the mu shim and the worker driver
  stamp milliseconds without GNU `date`, use `tee -p` only where it exists,
  and the real pi is linked as `pi` (a launcher may dispatch on its name).
  Before the AUT starts, a live run with real workers pre-trusts the fresh
  sandbox as a user's own repo is trusted: it starts claude (and codex with
  `codex-home`) once in a pane, answers the folder-trust and hook-review
  dialogs and quits before any prompt, so a worker of a harness the AUT is
  not no longer stalls at a dialog nobody answers; a step it cannot confirm
  becomes a run note.
  A live run cannot leak into the user's real mu state through their shell
  startup files: the sandbox's `mu`, `murmur` and `muzzle` shims pin its DB,
  state, sync dir, tmux server and murmur state whatever the caller's env
  says; a ZDOTDIR wrapper (codex's login shell) and claude's
  `CLAUDE_ENV_FILE` (claude's snapshot sources `~/.zshrc` itself) re-apply
  them, drop any `mu`, `murmur`, `muzzle` or `tmux` alias or function, and
  put the sandbox `bin/` first after the user's zsh files run; and a watch
  on the user's real sync dir, DB, murmur and muzzle state marks a run
  destructive (`contamination: ...`) when a new segment appears in the sync
  dir, notes every other change, and reports even when the run is
  interrupted.
- **Every blessed harness orchestrates in the evals; worker mixes per run**
  (spec U24, D17). `--harness` also takes `cursor-agent` and `muse`: each runs
  in a pane like claude and codex, started through `mu orchestrate` with the
  harness table's trust and approval flags (`--trust --sandbox enabled`,
  `--trust-workspace --approval-mode never`), which mu's worker presets do
  not give an orchestrator; it reads the surface's skill from a project skill
  committed in the sandbox repo (`.cursor/skills/mu`, `.agents/skills/mu`). A
  Muse AUT, which has no mu Stop hook (D7), is told to keep driving in its
  turn. `--workers <h1>,<h2>` on `run`, `matrix` and `check` picks the worker
  harnesses of E1, E3, E4 and E6; their prompts, titles and judges name the
  chosen harnesses, and the result row records them. E2 takes a cursor-agent
  or Muse AUT's model family from the `--model` the rig gave it (their hooks
  name no vendor) and tells one of unknown family plainly to use a claude
  refuter; a refuter of unknown family never counts as cross-family. A pane
  AUT whose own sandbox refuses a command is noted as an environment
  failure (`environment: ...`). A sampled live plan (claude, codex and
  pi run E1–E7; cursor-agent and Muse four cases each, with mixes that put
  every harness to work at least twice) is listed with its commands in
  [docs/eval/every-harness.md](../eval/every-harness.md) and proven at zero
  cost by `check --plan`.

### Changed

- **`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured** wherever mu reads or
  writes a harness's config, as the harnesses, murmur, museum and muzzle read
  them: `mu init` writes the hook entry, skill and prompt skills to
  `$CLAUDE_CONFIG_DIR/settings.json` and `$CLAUDE_CONFIG_DIR/skills`,
  `$CODEX_HOME/hooks.json` and `$CODEX_HOME/skills` when set (a harness is
  set up when that directory exists), and `mu doctor`, murmur's availability
  check and `mu host check`'s probe (in the host's own shell) read the moved
  files. Unset or empty: `~/.claude` and `~/.codex`, as before.

- **murmur keeps its state in `~/.local/state/murmur2`.** The hook-harness
  inbox needs murmur 2's store, which murmur 1.x refuses, so murmur moved
  to a new directory and its inbox and remote area always sit under the home
  directory. mu reads them only through `murmur pane` and writes only through
  `murmur hook mu`, so nothing in mu moves; the eval rig's sandboxed murmur
  state is named `murmur2` to match. mu's own state stays in
  `~/.local/state/mu-next`: its additions are additive at schema 13.

- **Docs: every harness first-class** (spec D16, U19). The skill gains a
  capability section per channel (`ctl`, `hooks`, `mux`), and "Checks are
  calls" now names the native-subagent path (`mu task check`/`verdict`)
  beside `mu_delegate`; it stays under its 600-word cap by dropping lines
  the recipe index already said. Recipes: `tasks-or-calls` gains "Outside
  pi" (a recorded native subagent, or a recorded cross-family `scratch`
  pane); `findings` puts one refuter of each high or critical finding in
  another family; `adversarial-review`, `course-correct` and `test-health`
  accept a native subagent; `orchestrator-loop` starts a non-pi
  orchestrator with `mu orchestrate` and names the `hooks` interrupt and
  ack; `worker` gains the brief pointer and the close nudge; `models`
  passes `--model` through each harness's flag; `remote-workers` gains the
  `hooks` remote path. Guides: `other-agent-clis.md` is now the per-harness
  setup guide (`murmur init`, `mu init`, `muzzle init`, a table and a
  section per harness); `stop-a-worker.md` and `remote.md` gain the `hooks`
  path; `dispatch.md` and `delegate.md` drop the claim that a non-pi agent
  on tmux cannot be sent to or has no final text. README, VISION §6 (now
  "Five first-class harnesses"), the surface contract and the package
  description say the five blessed harnesses are first-class and pi has the
  exact channel. `test/docs-harness.test.ts` pins it.
- **`mu state` and `mu next` read every identity of the caller.** A managed pi
  orchestrator is both `<ws>/<name>` (its spawns, its human stops) and
  `pi:<session>` (its delegate calls): its delegates, waves, human needs and
  `--refute` checkers are the union, as `mu wait` already did (spec D9).
  `state.caller` still names one identity. New records stay owned by the
  managed name.
- **No agent starts a tmux server.** Spawn and `ensureSession` refuse with
  `TmuxServerInAgentError` (exit 5, "start tmux from a terminal") when no tmux
  server is running and the caller is inside an agent: `MU_MANAGED_AGENT=1`
  or any harness's sandbox marker env (`CLAUDECODE`, `CODEX_THREAD_ID`, …). A
  server's panes inherit the server's sandbox, not the client's (spec D10). A
  running server is used as before.
- **`murmurAvailable(cli)`** is per harness: pi needs murmur's pi extension, a
  hook harness its `murmur hook <harness>` entries in its own config file. A
  missing pi extension still warns in `mu doctor` when claude hooks are
  installed, and an unreported non-pi agent reads `murmur hooks not
  installed` (spec D13).

- **Agent reads go through one channel seam (internal; no behaviour change).**
  `src/channels/` holds the `AgentChannel` interface at the wait seam, with a
  `ctl` implementation (pi's control socket) and a `mux` one (every other
  pane): state, watch, run baseline, msgId receipt, write fence and last text.
  The wait engine, `mu agent check`, the stall steer, the CLOSE notice, the
  `next` recovery and refute readers and `spawn --task` replay read through it;
  `test/channel-imports.test.ts` keeps them off `src/ctl` and off ctl's
  raw-socket functions, and one contract suite runs against both channels.
  `src/harnesses.ts` holds the frozen table of the five blessed harnesses, in
  murmur's names and with its argv-match fields. The SDK exports are unchanged. First unit of
  the every-harness-first-class spec (D4, D6).
- **Delivery goes through the channel seam too (internal; no behaviour change).**
  `AgentChannel` gains send, fresh, `command` (pi's `/new`, `/reload`,
  `/compact`), interrupt and abort. `ctl` runs them over the control socket
  exactly as before (`src/channels/ctl-deliver.ts`); `mux` hands a send to the
  backend's `sendToPane` and refuses the rest with the same typed errors as
  before. `mu agent send`, `--interrupt`, `--fresh`, `mu agent abort`, the
  stall steer, the CLOSE notice and `spawn --task` deliver through `deliver` or
  the agent's channel, and `test/channel-imports.test.ts` keeps every delivery
  call site off `src/ctl`. `sendViaTransport`, `abortAgent` and
  `interruptAgent` keep their signatures. Second unit of the
  every-harness-first-class spec (D4, D8).
- **Schema: `agents.channel`** (machine-local, `'ctl' | 'mux'`), added in place
  to a v13 file (no version bump). Spawn records the channel from the command
  it runs, and every verb reads it from the row, never from `MU_<KEY>_COMMAND`
  or the cli key. A recorded row is final: a socket file at a `mux` row's
  derived path (a remote non-pi worker's ssh `-L` binds one) no longer moves
  it to ctl, so an opaque wrapper around pi names `--cli pi`. A row older than
  the column keeps the derived rule, socket file included.
- **Schema: `agents.remote_key`** (machine-local), added in place to a v13
  file (no version bump): a remote hook harness worker's key on its node
  (spec D11); null for every other agent.
- **`{env}` may carry `MU_AGENT_CLI` and `MU_REMOTE_KEY`** besides the five
  identity variables; mu sets them only for a remote hook harness worker.
- **Schema: `keep_driving`** (machine-local: per harness session, the Stop
  hook's consecutive empty blocks and whether its close nudge fired), created
  in place in a v13 file by `upgradeSchema` (no version bump; 28 tables). Rows
  idle for a week go with the next write; `mu rebuild` does not carry it.
- **Schema: `checks`** (portable: id, task, checker, brief, verdict, state;
  op entity `check` under `<task key>#<id>`, which now syncs), created in
  place in a v13 file by `upgradeSchema` (no version bump; 29 tables;
  `CAPTURE_VERSION` 6; `SEGMENT_FORMAT_VERSION` unchanged). The fold is
  per-field LWW under the task's horizon, so a verdict that arrives before
  its brief lands either way. In the same transaction that creates the table,
  every `check` op already in the log is re-applied, so checks a peer synced
  before this machine upgraded appear. A 4.3 peer records `check` ops without
  projecting them, so it reports an `--if-ready` umbrella as ready without
  its verdicts. `check` is now a reserved `mu log --kind`; an older log line
  of that kind is ignored by apply. A local write (`mu db query --write`)
  must name a ULID id (anything else would file an op under a key no peer can
  project) and keep `state` matching `verdict`.

### Fixed

- **A codex worker's first prompt no longer lands while a launcher wrapper is
  still starting it** (spec D4, D6). A wrapper that prints a banner and
  installs plugins first (10 to 40 s on a fresh `CODEX_HOME`) swallowed the
  Enter after mu's paste, and the brief pointer sat unsubmitted in codex's
  input box. mu's first paste to a codex pane with no turn now waits, within
  `MU_FIRST_SEND_ACK_MS`, for codex's own ready screen (`readyMarks` in the
  harness table: its header or footer and its `›` input line; a banner,
  `Installing ...` lines, a dialog or a shell prompt never count), and the
  ack gets the rest of that window. A codex paste whose ack is 3 s late and
  whose text still sits in the input line gets the submit key once more, at
  most once, never a second paste (`submitRetry` in the send's result and
  `--json`; `readyScreen` says how the wait ended). Muse has no verified
  ready screen yet and keeps the old path; claude, cursor-agent and pi are
  unchanged.
- **The 60 s first-prompt ack window applies when murmur's hooks run it by
  path** (spec D4, D13). mu counted murmur's hooks as installed only for a
  command starting `murmur hook <harness>`, so a hook config that runs
  murmur as `'<node>' '<…>/murmur…/dist/cli.js' hook codex` (the eval rig's,
  or a hand-written one) read as hookless and the task spawn's pointer got
  `MU_SEND_ACK_MS` (10 s). Any command that runs murmur's `hook <harness>`
  (`runsMurmurHook`) now counts.

- **`mu hook stop` lets a worker go when its turn ends with a CLOSE block**
  for a task it owns (spec D7). The close nudge started another turn whose
  text replaced the report as the pane's last text, so the orchestrator
  never read the worker's verdict.
- **`mu hook stop` applies that CLOSE block itself** (spec D3, D7). Nothing
  applied it until the orchestrator's next `mu wait`, so an orchestrator
  polling `mu task show` saw the task IN_PROGRESS long after its worker had
  reported (live E3: 15 minutes). For a local claude or codex worker the hook
  now closes the task with the report, keyed as a wait's settle of the same
  turn is (the payload's `session_id`, murmur's `run_count`), so nothing
  closes twice. A replayed apply now names the task the first one closed
  (`replayedClose`), so the orchestrator's wait treats that settle and the
  task's close as one event, as when the wait applies the block, and a stall
  on the worker's other task does not call it refused. A remote worker's
  block is still applied by its orchestrator from the relayed text (D11),
  cursor-agent's (its text follows its stop) by the wait.
- **The first send to a codex or muse worker waits 60 s for its ack**
  (`MU_FIRST_SEND_ACK_MS`, spec D4). A launcher that installs plugins on
  first start kept codex from reading the paste for well over 10 s, so
  `mu agent spawn --cli codex --send`, a task spawn's pointer and the first
  `mu agent send` reported delivery `unknown` while the turn ran. mu's first
  prompt to a local codex or muse pane that murmur reports with no agent row
  (with murmur's hooks installed) now waits `MU_FIRST_SEND_ACK_MS` (default
  60000); every other send, a forced one included, keeps `MU_SEND_ACK_MS`.
- **`mu task check --by` takes a harness alone** (spec D5). `--by codex`
  records the check as `codex`; `--by claude/opus` is unchanged. A refused
  `--by` (orchestrators guessed `native/codex`) now shows both forms. The
  eval's E3 judge accepts a check recorded as `--by claude`.
- **Eval: pre-trust waits for each harness's own ready screen.** The codex
  step quit a launcher still printing `Installing ...` lines, before codex's
  trust dialogs, on a generic "a line led by `❯`" check that the shell's
  prompt also passes. Ready is now codex's `? for shortcuts` footer with its
  `›` input line, or claude's footer or input box; codex's hook trust counts
  only when every hook of the home's hooks.json has a `trusted_hash`.
- **Eval: the hook-harness cases (E1–E7) judge failed AUT mu calls alike.**
  A failed call was a wrong entry only for a pi AUT, whose tool calls are
  recorded; a claude or codex AUT's went uncounted. In these cases a failed
  AUT call is now a note (from the mu shim's log, for every AUT), never a
  wrong entry: the cases judge effects. Older scenarios are unchanged.
- **A first send to a new codex or muse worker passes the `hooks` gate**
  (spec D4, D17). codex and muse report a session only with their first
  prompt, so murmur has no row for the pane until then and the gate read
  `unknown`: `mu agent spawn --cli codex|muse --send <text>` (no `--task`)
  always failed, and a first `mu agent send` needed `--force`. mu's first
  plain send since the spawn (no `agent.send` op for the agent since its row
  was created) now passes a pane of a first-prompt harness when murmur
  answers with no row, no dialog and no crash, the pane still runs, and for
  a local worker murmur's hooks for that harness are installed. Any later
  send, a dead or gone pane, an unanswered murmur, missing hooks and claude,
  cursor-agent or pi with no row are refused as before: no row alone can be
  a rebuilt murmur store or hooks that never fire. It is confirmed only by
  `run_count` 1, as a task spawn's pointer is.

- **A slow `murmur status --json` reads as a timeout, not as no row.** mu
  waited 5 s; murmur's full drain can take longer when it rebuilds its socket
  cache. mu now waits 10 s, and a timeout reads `unknown` with its own reason
  (`murmur status timed out after 10s ...`), never "murmur has no row".

- **Remote workers get the auto-approve preset** (spec D17: approvals are per
  worker). A `--host` claude, codex, cursor-agent or muse worker launched
  from a resolved command gets its row's auto-approve flags in its remote
  command, as a local one does; a literal `--command`, an orchestrator and pi
  still get none.

- **The eval's fake claude reads hooks from `$CLAUDE_CONFIG_DIR`** when set,
  as the fake codex reads `$CODEX_HOME` (an empty value is unset for both).

- **The course check counts a close in the same millisecond as its anchor.**
  `courseCheckHint` compared each close note's time with a strict `>` against
  the workstream's creation or the newest `COURSE CHECK` note, so a task
  closed in the millisecond its workstream was made was never counted, and
  neither was one closed in the millisecond of the check. Notes are now
  ordered by time and then id: every close counts against the creation, and a
  close in the check's millisecond counts only if it was written after it.

## [4.4.1] — 2026-11-05

### Changed

- **A remote spawn refuses another owner's tree** (follow-up of reattach's
  install check, 2026-11-05). `mu agent spawn --host <profile>` without
  `--worktree` refuses (exit 4, `RemotePathOwnedError`) when the cwd its exec
  resolved is exactly, on that profile, another agent's managed remote
  worktree (host, cwd and base recorded; any workstream) or the path or aside
  of any `remote_recovery` record. Before, it succeeded and left two owners:
  close removes a managed tree and collect credits its commits to its owner,
  so the second user lost work or attribution. This refuses what used to
  work: sending a reviewer into a worker's tree. Give it its own tree with
  `--worktree --from <the worker's commit>`; the error prints that command,
  or the owner's close, or the record's collect and close with
  `--recovery <id>`. A refused command gate is offered the owner's close or
  the gate in an unmanaged checkout (`--cwd <repo root> --command <cmd>`;
  only the close when that root is itself a managed tree), never `--worktree`. Unmanaged checkouts stay shareable; subdirectories and
  other profiles naming the same host are not checked. The check runs right
  after prepare's exec (no pane, the agent never starts) and again in one
  immediate transaction with the row's insert; an owner that landed while
  the pane opened refuses there, after a kill, and a pane mu cannot prove
  gone is named with its backend's kill command (new `MuxBackend.killPaneCommand`);
  a pane id another agent's row now holds is left alone and said so, with
  no kill offered.
  Recovery, reattach, collect and close keep their own stricter checks.

## [4.4.0] — 2026-11-05

### Added

- **`mu host add --attach <template>`**: a lease profile's optional template
  that opens a new carrier for a job that still runs (2026-11-04 aiv-blog
  incident; the reattach verb builds on it). It takes `{job}` and `{job_file}`
  exactly once, `{local_sock}` and `{remote_sock}`, and `{cwd}` (always `.`);
  `{cmd}` and `{env}` are refused, as is `--attach` on a session profile.
  `host init --mule` prints the `mule run --lease --attach` starter line;
  `host show` and `host list` print it; `host check` expands it with a dummy
  handle and never runs it. Stored as `host_profiles.attach`, added in place
  to a v13 file (no version bump).
- **`mu agent reattach <name> -w <ws> [--if <rev>]`**: open a new carrier pane
  for a reaped lease agent whose job still runs (2026-11-04 aiv-blog incident:
  a tmux restart killed six lease panes, reconcile reaped the rows, and the
  jobs on a host with no master kept running with no way back). Bare previews
  (read only, `rev`); `--if <rev>` applies. The preflight refuses (exit 4,
  `ReattachRefusedError`, nothing changed, the close preview in `close`) unless
  the name has no row, one reservation bound to a spawned incarnation with a
  handle in this workstream generation (`carrier_jobs.workstream_id`, stamped
  at the bind and added in place to a v13 file; a reservation bound before it
  refuses as unknown), a previous pane and spawn process proven gone, a lease profile with an
  `attach` and the admitted `stop`, a usable recovery record (if any) and a job
  file that is absent or names the handle. The apply runs the profile's attach
  template in a new pane and, in one transaction, re-checks the record's
  admission (no other agent, in any workstream, on its host and path, no newer
  record of it, the pinned profile: another workstream's `--cwd` spawn can take
  the path during the apply's awaits), inserts the row (pi, the record's tree),
  rebinds the reservation and drops the record. A path taken by then kills the
  new pane and refuses (`ReattachRefusedError`; `pane-unknown` as below when the
  kill is not proven). A carrier that
  ends (job not running, no master) is rolled back with the record restored
  (`ReattachFailedError`, exit 4, the pane's scrollback); ctl `missing`/`refused`
  keeps the row (`ready: false`). An install that fails points the
  reservation at the new pane, then kills it: a kill not proven by a pane
  probe reports `rollback: pane-unknown` with the pane, and the next reattach
  refuses while it may run. A pointer write that fails (the writer lock that
  failed install) or loses its compare-and-set never skips the kill; an
  unproven kill retries it once, and if it still fails the error says the
  reservation does not name the pane. Before the pane is requested the apply
  publishes a pending-carrier marker (`<db dir>/locks/agent-<ws>.<name>.reattach-pending`;
  a failed write opens no pane) and removes it only once the pane is installed,
  named on the reservation or proven gone: after a double fault or a process
  killed mid-apply, the next reattach refuses while that pane may run (an
  unreadable or malformed marker, or one naming no pane, refuses too, naming
  the file to `rm`, shell-quoted so the printed command pastes as is).
  Preview and apply take the facts and the rev from one snapshot after the
  pane probe; a reservation that keeps changing refuses
  (`AgentReplacedError`, exit 4). Pi only: no other cli is stored. Logs
  `agent.reattach`. Spec: docs/specs/2026-11-04-lease-adopt.md § mu_adopt.
  `--task <id>` (repeatable) claims each task back for the new incarnation
  once ctl answers (`force`, since the reaper parked it; only an OPEN task, and
  only while the name is still this incarnation). A refused claim is a warning
  in `claims: [{task, ok, error}]`, exit 0; with ctl not ready every claim is
  `skipped: ctl not ready`.
- **Leftovers in `mu agent list`** (2026-11-04 aiv-blog incident: the list
  printed `"orphans": []` while reservations and recovery records were left).
  `data.leftovers` (bare and `--json`, `[]` when empty; the envelope and its
  `next` are unchanged) lists each lease reservation whose agent is gone
  (`kind: lease-job`, its recovery record folded in by agent id) and each
  other remote recovery record (`kind: recovery`), keys `kind name host job
  agent_id recovery_id stop_failed next`. `next` is one preview: `mu agent
  reattach <name> -w <ws>` when reattach's preflight is clear, else `mu agent
  close <name> -w <ws>` (a record's always with `--recovery <id>`). A lease
  job's stop-failure record (`<job_file>.<job>.stop-failed`) shows only when it
  names that handle, as the text after `<job> ` escaped like a task record (C0,
  C1, bidi, U+2028/9; other Unicode as is), cut at 160 chars and so the whole
  record (JSON item and table line) stays <= 400: ` cut=<n> full: mu doctor`,
  or `cut=<n>` alone with no room, or null when even that passes 400. The cap
  bounds stop_failed; identity and next are never cut, so at mu's limits
  (32-char name, host and workstream, 128-char handle, `--recovery` id >= 100)
  the record alone may pass 400. `--table` prints a
  `Leftovers (n)` section. No host command runs. mu removes the record once a
  stop (close or spawn rollback) or a ready reattach proves the job; an
  abandon keeps it. Doctor's `lease-job` hint prints the record's path.
  Spec: docs/specs/2026-11-04-lease-adopt.md § mu_list.

### Changed

- **The reaper parks a still-reserved lease agent's tasks.** When reconcile
  (or any deleter but `agent close`) removes a lease row whose reservation
  holds a job, its `IN_PROGRESS` tasks reopen as `OPEN/parked`, not
  `OPEN/todo`: pane loss proves the carrier gone, not the job, so `mu next`
  and a plain claim no longer hand the task to a second worker while the
  original pi may still write (2026-11-04 aiv-blog incident). The `[reaper]`
  note names the job, the host and both ways out: `mu agent reattach <name>
  -w <ws> --task <id>`, or `mu agent close` then `mu task unpark <id>`.
  A task owned from another workstream (`claim --for <ws>/<name>`) gets two
  steps instead, since `--task` resolves ids in the agent's workstream:
  reattach, then `mu task claim <id> -w <task-ws> --for <ws>/<name> --force`
  (or close, then `mu task unpark <id> -w <task-ws>`).
  `agent close` stopped (or abandoned) the job, so its tasks reopen as `todo`
  as before. Spec: docs/specs/2026-11-04-lease-adopt.md § mu_reap.

### Fixed

- **`mu agent close <name>` with no agent row no longer leaves a stopped lease
  job fencing the name.** It stopped the job (`stop` exit 0), then closed the
  removed agent's remote worktree, and only then dropped the reservation. So a
  dirty or uncollected tree made the close refuse, the reservation stayed, and
  every `mu agent spawn <name>` refused with "has an unstopped job". The
  reservation and the local ctl socket now go right after the stop, with their
  `agent.close` event, before the tree's close. A retry runs no second stop. A
  reservation a rollback kept as one tree's pointer is still released only by
  that tree's close. While a removed agent's `remote_recovery` record exists, a
  `--worktree` spawn of its name on its host refuses (exit 4,
  `RemoteRecoveryPendingError`, naming `mu agent collect` and `mu agent close`, with `--recovery` whenever
  the name has records on more than one host or several here) instead of
  making a new tree beside one the record may have parked aside.

## [4.3.3] — 2026-11-05

### Fixed

- **pi built on Bun hung with the mu extension loaded.** The extension ran
  its bundled CLI with `process.execPath`, which under a single-file Bun pi is
  pi itself, so every mu call (`mu delegates list` at session start, `mu wait`
  at settle) started a second pi that waited. `pi -p` never returned. Under Bun
  the extension now runs the CLI with `node` from `PATH`; under Node nothing
  changes.

## [4.3.2] — 2026-11-03

### Added

- **Rex as a third mux backend** (`MU_MUX=rex`, or run mu in a Rex
  terminal). A workstream is a Rex session labelled `mu-<ws>`, an agent a
  terminal block. mu drives Rex through its server API (`rex api call`),
  so spawn is one call that never takes focus. Agent state for non-pi CLIs
  comes from the program's own OSC 7501 report (`program_status`), and
  non-pi sends are a paste event plus Enter (a multi-line text is refused
  unless the agent turned on bracketed paste). Panes run the command through
  `$SHELL -ic`, so agents see the environment of the user's own Rex tabs.
  Attach asks Rex.app to switch (`rex do session.select`), which needs
  Remote Control on.
  `MU_REX_SERVER` points mu at another server. See
  [backends](../guide/backends.md).

### Changed

- **The dashboard names its window `mu`, not `node`.** Bare `mu` sets
  `process.title` (tmux's automatic window name) and the terminal title (OSC 2),
  then restores the caller's title on exit.
- **Recipes: merge a batch through a short-lived merge task.** Past about 4
  workers, the new [merge](../../skills/mu/recipes/merge.md) recipe
  hands each batch to a `merge_<n>` task in its own worktree. The task
  cherry-picks, resolves append-only conflicts and runs the gate, and it never
  pushes. The orchestrator checks the GATE record and pushes fast-forward
  only. This keeps gate and conflict noise out of the orchestrator's context
  without a long-lived merger role. [course-correct](../../skills/mu/recipes/course-correct.md)
  now measures merge latency split into gate/CI time and queue wait.

## [4.3.1] — 2026-11-02

### Fixed

- **`mu wait` no longer fails for good after a workstream is torn down.** A
  caller's wait registration kept task and agent refs into the torn-down
  workstream, and every read of them threw `WorkstreamTornDownError`, so
  every ownerless `mu wait` (and every pi settle) exited 3 and live work in
  other workstreams was never waited on. Such refs are now owed nothing: the
  wait drops them from the registration with one stderr line (`mu wait:
  dropped N ref(s) into torn-down workstream <ws>`) and waits on the rest.
  The wait's per-ref task reads never throw either, so a workstream torn down
  mid-wait (or an explicit ref into one) reads as gone.
- **A deliberately closed agent is never a `dead` event, and registrations
  shrink.** An agent's ref stayed in every caller's wait registration unless
  the close found it idle with no open task, or a wait had seen it finished,
  so a worker closed mid-run (or while it still owned a task) later fired
  `dead` (exit 6) on some unrelated wait, and the registration grew without
  bound (one session held 249 refs). `mu agent close` now drops the agent's
  ref from every caller's registration. Work it left unfinished is still owed
  through the task refs (the reaper reopens those tasks), and a pane that
  dies on its own is still `dead`.

### Test health

- **The eval unit tests no longer leak temp dirs.** `test/eval/lifecycle.test.ts`
  and `test/eval/judges-effects.test.ts` left 11 `lifecycle-test-*`, `judges-fx-*`
  and `judges-effects-*` dirs in `$TMPDIR` per fast run; they now remove them in
  `afterAll`.

## [4.3.0] — 2026-11-01

### Added

- **A worker is told when its CLOSE block was refused.** A malformed block
  (the line after `CLOSE:` is not `REPORT:`, an empty report, bad quoting)
  was recorded on the task and never reported back, so the worker repeated
  the shape (aiv-blog: 67 refusals; seen across 70 earlier sessions). Now
  the wait that sees the refusal sends the worker one fixed **close
  notice**: the reason, the exact shape, and "if it is not done, do not
  write CLOSE: at all". A `mu wait` or `mu task wait` of the caller that
  spawned the worker sends it, `--on-stall` and `--until-text` or not, also
  when another caller's wait saw the run first (`mu agent wait` applies no
  CLOSE blocks and never sends it). Once per run and at most 3 per pi
  incarnation, after which the stall is the orchestrator's as before; a
  run that got the notice is not also steered (`--on-stall steer`). Other
  refusals (not the owner, a human task) are not sent. A returning wait
  gives notices in flight at most 3 s and never outlives its own timeout
  or abort for them.

### Fixed

- **Re-spawning a task whose worker died no longer pretends to restart it.**
  `mu agent spawn <name> --task <t>` after the attempt's worker was closed
  (or reaped, or its name reused) replayed the old delivery: it printed
  `prompt delivered`, exited 0 and started nothing. Such an attempt has
  ended, so the replay now exits 4 (`SpawnAttemptEndedError`) and names the
  next free key: `pass --attempt <t>-2` (a numeric suffix longer than 9
  digits counts as part of the key). The key still never sends a second
  prompt. A `mu next --refute` checker whose agent is gone ends as an error
  instead of being marked running.
- **A dropped lease connection no longer reads as a dead agent.** When a
  watched agent's control socket stopped answering, the wait called it
  dead (`exit 6`, "its pane died or it was closed") even with the pane up.
  A lease's forwarded socket goes down with the mule master while the pane
  and the job live on, so a drop reported every remote agent dead and
  invited a second copy of each run. Now a lost socket is a death only
  when the pane is gone or exited (tmux), or no agent occupies it any more
  (herdr, whose pane outlives its pi as a shell). A lost socket on a live
  pane, or a multiplexer that cannot answer, is `unknown` and the wait
  keeps polling.
- **A run that finishes while a lease connection is down still closes its
  task.** A mule master drop breaks the wait's held ctl watch, and the wait
  falls back to polling. A run that settled before the forward came back
  was then seen only by a poll, which carries no run text: the wait
  reported "finished its run" and the CLOSE block never applied, leaving
  the task IN_PROGRESS. Now a poll that sees a pi agent's run past the
  baseline re-opens the watch at that baseline (once per run); the
  extension answers at once with the settled run's text, and the block
  applies as usual. A wait that starts while the forward is already down
  sets its watch up once the socket answers again.
- **A remote close accepts a HEAD already on a branch.** `mu agent close`
  refused a remote worktree whose HEAD was "never collected" even after it
  was merged in the root repo (`git merge --ff-only` there), so every
  close needed `--keep-branch` and left a redundant `mu/<ws>/<agent>-<sha>`
  branch. A HEAD that any branch or remote-tracking ref of the root
  contains now removes with no branch. The removal checks that again just
  before it runs: a branch deleted or moved meanwhile refuses ("no longer
  on any branch"), so the commits are never lost.
- **`mu agent close`'s preview names the processes inside the worktree.**
  The apply removes a tree under a reader (a reviewer still reading it)
  and refuses a writer, but the preview never said who was there: the
  warning came after the tree was gone (seen 3 times, aiv-blog among
  them). The preview now runs the same holder scan, leaves out the
  agent's own pane processes that the kill ends (its pi and their
  children in the pane's session; a `setsid` one survives the kill and is
  listed), lists each other process with what the apply will do, and
  names the processes it could not inspect. `--json` carries
  `worktree.holders` and `worktree.hidden`. New optional mux methods
  `panePid` (tmux; herdr shows every holder) and `paneOccupied` (herdr).
- **`mu human-needed` says when it extended an open stop.** A second
  reason joins the caller's open stop (one task, closed as a whole); it
  printed "Recorded" with the old id. It now says the reason was added,
  names the close command (with `--evidence`), and points at `--no-stop`
  for a separate to-do; `--json` carries `extended`.
- **A mu_delegate call whose attempt ended is not parked forever.** A
  delegate's replayed attempt whose agent is gone (`SpawnAttemptEndedError`,
  or a delivery-unknown replay reporting `task.stale`) was parked as
  reissuable, but every reissue replayed the same attempt; it now ends the
  call (failed) with "issue a new mu_delegate call".

## [4.2.2] — 2026-10-30

### Added

- **`mu human-needed --no-stop <reason>`: a human to-do that does not stop
  the loop.** It records the same parked `human` task (shown in the
  dashboard's attention, closed only by `mu task close`) without the stop, so
  the settle, `mu next` and its hints go on. One task per reason; an identical
  open one is a no-op. Use it for "tag it" or "the rollout week": orchestrators
  had been piling those into one standing stop.

### Changed

- **A human stop no longer strands work already running.** With a stop open,
  the settle used to show only what was ready and end the turn, so workers and
  delegates dispatched before it finished unseen until the human typed. Now
  the settle waits as usual while the caller owns work and continues on each
  event, led by a drain rule ("collect and merge what you started; start
  nothing new; a stalled or dead worker: tell the human") and the stop's
  reasons. It ends the turn when nothing is owed. A wave is no longer cut
  short by a stop. `mu next`, its hints and the guarded stall release still
  refuse under a stop.
- **Scratch cleanup is discoverable.** `mu delegates prune --older-than 0`
  now means every closed delegate task (0 was refused as not positive).
  Teardown, which never touches `scratch`, ends with that command when scratch
  holds closed delegate tasks, and doctor's `delegates-old` row counts the
  newer ones too.

## [4.2.1] — 2026-10-30

### Changed

- **A stalled tool means a quiet one, not a long one.** The dashboard's
  `stalled` attention item fired on any tool that had run 15 minutes, so a long
  build or test run that was printing away read as needing you. The pi
  extension now tracks each running tool's last `tool_execution_update` (bash
  streams one per output chunk; a nested call's update counts for its parent,
  so a codemode script that logs is not quiet) and the ctl status's tool
  carries `quiet_ms`. `stalled` now means no output for 15 minutes, labelled
  `<agent> <tool> quiet <age>`. `quiet_ms` is measured on the agent's machine,
  so a remote host's clock skew cannot distort it. An agent running an older
  extension (including a remote host on an older mu) sends no `quiet_ms` and
  keeps the old run-time rule. A command that is silent by design
  (`cargo test -q | grep …`, a long `sleep`) still flags.

### Fixed

- **The attention strip no longer says `human: human needed:`.** A human task's
  item drops the `human needed: ` title prefix, since the strip already labels
  it `human: `.

## [4.2.0] — 2026-10-29

### Added

- **A host template's exit 3 is a hand-back.** The remote-workers recipe already
  told agents that exit 3 means a human must act, but no code did: the step just
  failed like any other. `exec` and `fetch` runs now throw `HostHandbackError`
  (label `human needed`, exit 5, `data.handback` in `--json`, the template's
  first stderr or stdout line as the detail). Never retried, and never recorded
  as `human-needed` automatically. `host check` reports a `handback` step and
  skips the rest (the report still prints); spawn prepare, close and collect
  stop with it, and so does a remote command gate's result read (`mu wait` ends
  with it after one template call); a rollback or gate cleanup, which swallow
  every failure, still do.
- **`host check` warns about a session `shell` template that can ride a shared
  ssh master** (no `ControlMaster=no` or no `ControlPath=none`). A warning in
  `warnings` and on a `warn` line, never a failure.

- **Lease transport, part 1: the host profile.** `mu host add --transport
  lease --stop <template>` stores a profile whose pane runs a local carrier that
  owns a detached remote job instead of holding an ssh session
  ([spec](../specs/2026-10-28-lease-transport.md)). A lease `shell` must
  contain `{job_file}` exactly once plus `{local_sock}` and `{remote_sock}`; a
  `stop` must contain `{job}` (`{cwd}` is always `.`, `{env}` is refused) and a
  session profile refuses `--stop`. The lexer enforces which placeholder each
  field takes (`{{job}}` is a literal, `:sh` and quotes are read right), never a
  substring check. `host show` and the human `host list` (a STOP column) print the
  transport and the stop; `host
  init <name> --mule` prints the starter (`env {env} sh -c {cmd}`, `mule rm
  {job}`); `host check` on a lease profile checks the shell's placeholders,
  expands `stop` with a dummy handle without running it, runs the `pi` and
  extension steps without a login shell, and with `--agent` reports the agent's
  job handle. New machine-local table `carrier_jobs` (the handle and the `stop`
  recorded with it; no FK, trigger, op or sync; agent deletion never touches
  it; `mu rebuild` reports it lost), `runStop` (runs `stop` only if the profile's
  `stop` still equals the recorded one; exit 3 hands back; a failure keeps the
  handle) and the job-file path `<state dir>/carrier/<ws>/<agent>.job`. Close
  and `doctor` are part 3 below.
- **Lease transport, part 2: `agent spawn --host` on a lease profile.** Prepare
  rides a transient channel that is released once prepare ends, and the pane
  binds no `host_channels` row, so `--max-sessions 1` still admits `collect`
  while the worker runs. `{job_file}` is filled into the `shell` template. While
  the name holds a `carrier_jobs` reservation (see below), the spawn refuses
  (exit 4: `<name> has an unstopped job <handle> on <host>: mu agent close
  <name>`). The **job
  handshake** is mandatory for a lease and independent of ctl, `--no-ctl` and
  `MU_SPAWN_CTL_MS`. mu waits up to `MU_SPAWN_JOB_MS` (default 30 s, never 0)
  for one handle line and fills it into the name's reservation in one
  statement guarded by the reservation's spawn token alone, so the handle is
  recorded even when no agent row survived. A pane that dies first is
  `AgentDiedOnSpawnError` with its scrollback. A live pane with no handle is
  rolled back. **Rollback** kills the pane and re-reads the job file. A handle is filled into the reservation first
  (even when reconcile already removed the agent row), then stopped, and only
  then is the worktree removed. A failed stop keeps the worktree and the handle,
  and says so. A lease profile refuses command gates (exit 2) before any effect.
  `mu next` names the handle and `mu agent close <name>` for a dead lease
  worker.

- **Lease spawn: the name is reserved before the carrier launches.** A lease
  spawn inserts a `carrier_jobs` **reservation** for (workstream, name) under
  the agent lock, before any effect. The reservation is name-exclusive and every
  update is guarded by its spawn token. Its `launch` turns `intent`
  immediately before the mux is asked for the pane. The pane and incarnation
  are bound as soon as they are known, and the handshake fills in the handle.
  While a reservation exists, every spawn of the name refuses (exit 4), lease or
  not, `--worktree` or `--cwd`. Every spawn holds the strict agent lock (the
  one the reservation is inserted under) from its in-lock name check until its
  pane exists and its row is finalized, so no reservation lands between the
  check and the pane command. The agent-row insert checks this in the same
  statement. The message names the handle, or says the job is unknown, and
  names `mu agent close <name>` (`--abandon-job`).
  - **Job-file reads fail closed.** Only ENOENT means "no file". An unreadable
    file (`LeaseJobUnreadableError`), an empty one or an invalid one keeps the
    reservation, with the reason, and the tree.
  - **Rollback acts only on its own reservation.** It never acts on the shared
    job file of a replacement.
  - **Release is conservative.** A reservation is released only after a
    successful stop and the cleanup of its job file and tree, by its creator's
    rollback while `launch` is still `none` (failures that precede the tmux
    call) and any remote worktree it prepared is removed, or by
    `--abandon-job`. A failed removal keeps the reservation with the reason:
    the placeholder row recorded no path, so it is the tree's only pointer. A
    launched carrier with no handle (a timeout, pane death, a tmux hook
    failing after the window opened) keeps the reservation, because the carrier may still publish. A job file left by an
    earlier reservation is moved aside, never deleted.

  This fixes four review findings: a finalize failure lost the only handle; a
  respawn erased an invalid job file; an unreadable file removed the tree; a
  rollback stopped the replacement's job.
- **Lease transport, part 3: `agent close` stops the job.** On a lease agent,
  the fenced check-then-kill is unchanged; after the liveness proof, close runs
  the profile's `stop` for the name's reservation and only then frees channels,
  unlinks the ctl socket and job file and applies the remote worktree rule
  ([spec](../specs/2026-10-28-lease-transport.md) § agent close). Exit 0
  releases the reservation, last. Exit 3 is `HostHandbackError`; any other
  failure names the template's first stderr line; a changed `stop` refuses
  naming the handle. Each keeps the agent row and the reservation. A handle the
  handshake had not recorded yet is read from the job file. A reservation with
  no handle refuses (`CarrierJobUnresolvedError`, exit 4: spawn in progress,
  or a carrier that may still publish) unless it was provably never launched.
  `--force` never skips the stop. New **`mu agent close <name> --abandon-job`**
  drops the handle without a stop and logs an event naming the host and the
  handle (the job file is left). It is the only way past a host that is gone
  for good. The reservation (handle, launch, pane, incarnation) joins
  `agentRevision`, so a preview taken before the handle landed fails `--if`.
  With no agent row left (reconcile, teardown, workstream delete, a raw `mu sql
  --write` delete), `agent close <name>` previews `kind: "lease-job"` (or the
  recovery), stops the reservation first, then closes the `remote_recovery`
  worktree. `agent collect` never stops a job. A respawn
  refused by a reservation that a failed, never-launched spawn kept for its
  remote tree now names the tree and `--abandon-job` instead of "in progress"
  (`CarrierJobUnstoppedError.reason`).
  - **A kept reservation names its own tree.** A rollback that cannot remove
    the remote worktree it prepared records which tree it kept the reservation
    for (`carrier_jobs.tree_path`, `tree_agent_id`: the path on its host and
    the placeholder incarnation). A close with no agent row releases that
    reservation only after closing that very tree (host, path and
    incarnation). Closing another recovery of the same name, such as an older
    incarnation's tree, leaves it in place and refuses
    (`CarrierJobKeptError`, naming both trees).
  - **No pointer refuses.** A lease agent with neither a reservation nor a job
    file now refuses with `CarrierJobUnresolvedError` (spawn in progress).
    The row and the tree are kept and nothing is stopped. Before, it fell
    through to a session close and removed the tree. Lease-ness comes from the
    transport recorded on the row at spawn (`agents.host_transport`), not from
    the profile as it is now. A row from before that column falls back to the
    profile or a job file. `--abandon-job` is the way past.
  - **Close-by-name unlinks the ctl socket.** With no agent row (for example,
    after a raw `mu sql --write` delete), the close unlinks the local ctl
    socket for (workstream, name) after the stop and the tree, before
    releasing the reservation.
- **`mu doctor` lease-job hint.** A `lease-job` housekeeping row lists each
  `carrier_jobs` reservation whose agent row is gone, or that was never bound
  while no agent holds the name. Each entry shows its handle (or its launch
  state and reason) and `mu agent close <name> -w <ws>`. It is a hint, never a
  FAIL and never a non-zero exit, because a job that ended normally leaves one
  until the next close. `--json` carries the list as
  `housekeeping.leaseJobs`.
- **`scripts/smoke-lease.sh`: the lease operator smoke.** You invoke it
  yourself; vitest never runs it. It builds mule and mu and drives the real
  mule from a lease profile against a loopback `sshd MaxSessions 1`, with a
  ctl-speaking fake pi (`scripts/smoke-fake-pi.mjs`) as the remote job. It
  asserts the spec's smoke list: spawn, `ssh -S <second master> host true`
  during the worker, send and wait with the settled echo, a close that leaves
  no job, forward, socket, job file, worktree or `carrier_jobs` row, and
  `kill -9` of the carrier, then reconcile, then a close by name that stops
  the job. A missing prerequisite fails it (exit 2). All state is private, and
  an exit trap stops every process it started. How to run it is in
  [remote.md](../guide/remote.md#smoke-test-a-lease-end-to-end).

### Changed

- **Hashed socket paths moved to `_h/`.** A long-path control socket is now
  `<state dir>/sock/_h/<hash>.sock` (was `sock/h/`), the remote one
  `/tmp/mu-<uid>/_h/<hash>.sock`, and the lease job file `carrier/_h/<hash>.job`.
  A workstream may be named `h`, so `h/<hash>` could alias another pair's hashed
  path (same local socket, different remote). `_` cannot start a workstream
  name. Agents with a hashed path get the new one on their next spawn; a running
  one keeps its old socket file.
- **Schema (still v13, additive):** `host_profiles` gains `transport` (default
  `session`) and `stop`; `agents` gains `host_transport` (the profile's
  transport at spawn, nullable); `carrier_jobs` gains `tree_path` and
  `tree_agent_id` (nullable); the 27th table `carrier_jobs` joins `MACHINE_LOCAL_TABLES`.
  An existing file is completed in the one upgrade transaction. `carrier_jobs`
  has its final reservation shape (surrogate id, unique `token`, `ordinal`,
  `launch`, `creator_pid`/`creator_start`, nullable `agent_id`, `pane_id`, `job`
  and `reason`, unique `(workstream, name, ordinal)`). A local file with the
  earlier unreleased shape (one row per incarnation) is rebuilt losslessly in
  the same transaction: every row becomes a filled reservation with its job,
  stop, incarnation and time intact.
- **`src/agents/spawn.ts` is split** (1566 → 1193 lines, under the 1500 cap): the
  remote half of `spawn --host` moved to `spawn-remote.ts` and the handshake,
  liveness and startup-scan helpers to `spawn-ready.ts`. No behaviour change;
  `agents/spawn.js` still exports every public name.

### Fixed

- **`host check` picks login or bare shell from the admitted profile**, not one read before the pane probes, so a profile edited mid-probe is not certified through the other transport's shell.
- **The `host init --ssh` starter comment named the wrong failure.** A multiplexed
  ssh does bind the `-L` forward, in the master, where it outlives the pane and is
  never re-bound. The options stay; the comment and `docs/guide/remote.md` now say why.
- **A host template interrupted by a timeout gets 5 s, not 0.5 s, to wind down**
  (TERM, then KILL), so a transport that must clean up after itself can.

## [4.1.1] — 2026-10-28

### Changed

- **`mu agent list` prints JSON by default; `--table` for the human table.** The
  4.0 interface design names agent list beside waits, `sql` and `state` as a JSON
  verb, but it printed a coloured table unless `--json`. It now prints the same
  `{workstreamName, agents, orphans}` envelope with no flag, failures included
  (stdout, real exit code); `--table` prints the old table. As with `mu state`, a
  machine with no multiplexer still gets the one human install line. A script
  that scraped the table must add `--table`; `--json` callers are unaffected.

### Fixed

- **`mu next` failures are its one JSON document.** `next` prints ONE JSON result
  with no `--json`, but a parse error (`mu next --bogus`) or a handler error (no
  `-w`, an unknown workstream) printed red prose on stderr and a help dump. Both
  are now the failure envelope on stdout with the real exit code, like `mu state`
  and `mu wait`. `mu me next` and a workstream named `next` are unaffected.

## [4.1.0] — 2026-10-28

### Added

- **`mu delegates prune`.** Every delegate call left a `scratch` task, with its
  whole brief and report, forever. Prune deletes the closed ones older than
  `--older-than <days>` (default 30) that this machine's calls made: the task
  rows in one `delegate.prune` op group (the tombstones sync, so peers drop them
  too), their notes and call rows, and their puts in the ops log (with
  `MU_SYNC_DIR` set, only peers' puts: this machine's own are what a damaged
  segment is rebuilt from). It keeps a task with edges and a refute check of a task
  with `mu task auto` enabled (pruning it would rerun the checker); verdicts stay
  on the judged tasks. The pruned calls' pi session files go too:
  `delegate-sessions/<ws>/<task>/` and `delegate-process/<hash>/`, plus loose
  session files of the first per-workstream layout past the same age (at least a day, this DB's workstreams only); a call
  that stays keeps its receipt. Dry run by default;
  `--yes` backs up beside the DB, VACUUMs and runs the drift check, like
  `mu db forget`. `mu doctor`'s housekeeping section gains `delegates-old`, the
  count with the commands.

- **The dashboard shows delegate calls.** A `kind=delegate` task row on the Tasks
  tab carries its call: state, verdict and the task it judges
  (`done REFUTED > ws/fix_auth`); the `/` filter matches them. A refused call is
  an attention item (`delegate`) for any caller, a human shell included; Enter
  opens the delegate task's notes. A failed call is not: it is final, its caller
  had the settle, and its row on the Tasks tab shows it in red. The
  Overview gains a Waves card when the shown workstream has waves: each of the five
  newest with its calls, verdict counts and how many were refused.

- **Attention items carry their fix; `y` copies it.** On the Overview, `y` on an
  attention item copies the `mu` command that clears it instead of the drill's
  read command: `mu agent close <name> -w <ws>` for a dead agent (it previews;
  `--if` applies), `mu delegates finish <call-id> --outcome cancelled --no-record
  --author "$USER"` for a refused delegate call (so a call whose pi session is
  gone can be cleared from any shell), and `mu task close <id> -w <ws> --evidence
  '…'` for a human task. Permission, input and stalled items keep Enter and
  attach. The dashboard stays read-only: the operator runs the copied command
  (`DashboardAttention.fix`, `Row.fix`). Read-only, from `delegate_calls`
  (`loadDashboard`'s new `call` and `waves`), bounded in SQL so a tick does not grow
  with the delegate history; a new index, `idx_delegate_calls_state`, serves the
  attention scan (created on open, no schema bump).

### Changed

- **A host profile names a machine; the repo is chosen at spawn.** A profile
  carried one `repo`, so two repos on one box meant two profiles, and each
  profile counted its own `max_sessions`: the cap no longer protected the
  machine. `mu agent spawn --host <p> --worktree --root <remote repo>` now picks
  the repo per spawn (`--root` was refused with `--host`); the profile's
  `--repo` is an optional default. The repo's absolute toplevel is recorded as
  `agents.repo` (new machine-local column), and close, rollback and recovery
  run against it, never against the profile; a respawn hint carries it as
  `--root`, and it is part of a `--task` attempt's identity. With `--host`,
  `--root` alone (no `--worktree`) names the start directory. A bare repo works:
  the host reports the root's physical path, hex-encoded so no byte of it is
  lost. Without a repo, templates get `.` for `{cwd}`, never a quoted `~`, and
  a gate reads its result through `.`, not its own cwd. A recovery record's `host_repo`
  is that repo; the profile check is `exec` only, so editing a default repo no
  longer strands older workers. `host check` takes `--root` and skips the repo
  step without one; `host list`/`show` print the default repo, `-` when none;
  `host init --ssh` no longer prints `--repo`. No migration (schema stays 13):
  opening an older file drops its host profiles (re-add them) and replaces the
  recovery triggers with `remote_recovery_*_v2`. Spec:
  [docs/specs/2026-10-28-host-profile-per-machine.md](../specs/2026-10-28-host-profile-per-machine.md).

- **The dashboard's notes drill draws each note under a header rule.** The
  rule shows `#n`, the kind in its colour (brief cyan, report green, verdict
  yellow), `pinned`, the author and the time. The content is indented under it,
  and the note's first `VERDICT:` line is green for CONFIRMED, red for REFUTED
  and yellow otherwise, read the way `parseVerdict` reads it (`VERDICT: <id>
  CONFIRMED` included); a later `VERDICT:` line is quoted evidence and stays
  plain.
- **Delegate sessions leave your `/resume` list.** A pi pane spawned for a
  `kind=delegate` task (every `mu_delegate` reviewer and refuter) now keeps its
  pi session in `<DB dir>/delegate-sessions/<workstream>/<task>` through
  `PI_CODING_AGENT_SESSION_DIR`, not pi's per-cwd folder, which they used to flood
  (175 of 208 sessions in one repo). Mux-free delegate processes already ran with
  their own `--session-dir`. Workers on `work` tasks are unchanged.

### Fixed

- **A delegate's timeout is one deadline across `/reload`.** The reloaded runtime
  re-adopted a running call with its whole `timeout` again, so each reload restarted
  the countdown. It now waits only for what is left, counted from when the call went
  `running` (at least 1 s, so an answer that landed meanwhile is still recorded).

- **The keep-driving nudge no longer shows ragged line breaks.** The rule quoted
  from SKILL.md kept the source's hard wraps, which the TUI then wrapped again.
  Each paragraph is now one line.
- **A wave's settle entry no longer dumps the first wait's JSON.** Its snapshots
  predate the siblings' answers, so they showed calls as `running` that the wave
  summary below listed as `done`. The wave summary stands alone, with the
  waits' `notices` (a course check due) as `Notice:` lines; the JSON stays when
  the wait carried a human need. A wave that is not all in (another event came
  first, a failed wait, Esc) says so instead of "waited until the wave was in".

## [4.0.0] — 2026-10-28

**mu 4.0: a rewrite for agent callers.** Every verb, result and error is shaped
for a model to read and act on, and only the dashboard is for a human. The
database, the ops log and the task DAG carry over in spirit, but 4.0 is a
breaking release with its own DB.

Upgrade: [docs/guide/upgrade.md](../guide/upgrade.md). Then run `mu doctor`
and send `/reload` to running pi agents.

### Breaking

- **A new DB and state dir.** 4.0 keeps its state in `~/.local/state/mu-next`
  (`$XDG_STATE_HOME/mu-next`), schema 13. It never imports a 3.x DB: a DB older
  than v13 is refused (`SchemaTooOldError`, exit 4, file untouched). Open work
  moves one workstream at a time with the
  [move recipe](../../skills/mu/recipes/move.md). A `MU_SYNC_DIR` that holds a 3.x segment
  is refused (exit 4): give 4.0 its own sync folder. Sync segment lines are v2 only.
- **Scope is explicit.** Pass `-w <name>`, a qualified `<ws>/<id>` ref, or run as a
  spawned worker (its injected `MU_WORKSTREAM`). `$MU_SESSION` and the tmux session
  name no longer route a verb. An unknown `-w` is exit 3 on every verb.
- **One JSON document.** `--json` prints exactly `{ok, data, next}` on stdout,
  errors included, and every result's `next` is computed from state. Task reads
  (`list`, `next`, `show`, `tree`, `notes`) print bounded records (one escaped
  TAB-separated line per task, a result under 4 KB, a cut says how to get the rest).
  `mu state` and `mu me` are one canonical JSON document.
- **`mu wait` is the one wait, and `mu task wait` is its alias.** It prints one JSON
  result with no flag, returns on the first event the caller owns (`closed`,
  `settled`, `input`, `dead`, `stall`, `delegate`, ...), takes typed refs
  (`task:`, `agent:`, `delegate:`) or none, and a timeout is `ok:true` with exit 0.
  Default timeout and cap: 1500 s. `--all` keeps the all-of loop; `--resume <id>`
  restarts a cut wait losslessly.
- **Removed verbs and flags.** `mu link pi` (pi loads mu as a package; `mu pi migrate`
  moves an old shim aside), `mu workspace` and `--workspace*` (use
  `mu agent spawn --worktree [--from] [--root]`, `agent close --discard`), the jj, sl
  and `cp -a` workspace backends, `mu undo`, `mu agent kick`, `mu agent adopt`,
  `mu agent remote-env`, `mu agent send --via`, `--strict-staleness`, the card TUI,
  the v7-v10 migration sidecar, pane titles and borders, and the env vars
  `MU_SEND_DELAY_MS`, `MU_SEND_READINESS_MS`, `MU_BANNER_QUIET`, `MU_NO_TUI`,
  `MU_TUI_DEBUG_MOUSE`, `MU_EXTENSION_ENTRY`.
- **tmux no longer pastes into non-pi agents.** `mu agent send` to a non-pi agent on
  tmux is refused (`AgentSendUnsupportedError`, exit 4); start the agent with its prompt
  as an argument. pi agents use the control socket and herdr uses its atomic
  `agent prompt`.
- **Teardown is soft and previewed.** `mu workstream teardown` prints counts and
  `rev=<n>`; `--if <n>` applies. Tasks and notes stay, hidden. `mu agent close` and
  `mu task delete|block|unblock|reparent|claim|release` take the same `--if <rev>` guard.
- **Identity is `$MU_AGENT_NAME` only.** Spawn injects exactly six variables
  (`MU_MANAGED_AGENT`, `MU_AGENT_NAME`, `MU_WORKSTREAM`, `MU_CTL_SOCK`, `MU_DB_PATH`,
  `MU_STATE_DIR`), plus `SSH_AUTH_SOCK` forwarding.
- **`mu sql` and `mu db query` read by default.** A write needs `--write` and is one
  captured op group; non-read-only PRAGMAs, `BEGIN`, edits that would diverge a rebuild,
  and writes to capture state are refused.
- **Delegate answers come through the settle wait.** The pi follow-up echo of the
  answer text is gone; the continuation carries the call's report.
- **Exit codes that moved.** A timeout of `mu agent wait` is exit 0 with
  `timedOut`, like `mu wait` (it was 5; exit 5 now means only an abort or interrupt
  that timed out). A close with no reason (`task close` without `--evidence`, `--as`
  without `--why`, a `mu sql --write` close with no note) is exit 2 (some paths were
  4). `mu db backup` onto an existing file is exit 4 (was 2). `mu delegates show` of
  an unknown call is exit 3 (was 2), and `task claim` with no claimer is exit 2
  (was 1).
- **`mu task next` has no `--status` or `--substate`.** It reads the `ready` view, so
  they could only narrow it to nothing; filter with `mu task list`.
- **`mu task add --json` prints the read verbs' record.** `data.task` and
  `data.tasks[]` carry `id`, `effort_days`, `workstream_id` and `scored: 0|1`, as
  `task show` does (they were `name`, `effortDays`, `workstreamName`, `roi`, ...).
- **`mu agent close` proves the worktree is unused before removing it.** A process
  with a file open for writing in it, or a scan that cannot run, refuses (exit 4);
  `--force` overrides that, never dirty files or unmerged commits. A shell or
  reader inside a clean tree is named in a warning and the close goes on. A failed
  spawn's rollback follows the same rule and keeps a worker's commits on a branch.

### Added

- **Delegates are durable tasks.** Every `mu_delegate` call is a `kind=delegate` task
  (default workstream `scratch`) with the prompt as its brief and the answer as its
  report, under `mu delegates` (`register`, `list`, `show`, `tally`, `reissue`).
  `mu_delegate_reissue` retries a refused call; a `wave` label groups a fan-out and
  tallies its verdicts. Delegates survive `/reload`.
- **Delegates need no multiplexer.** With no tmux or herdr, a call runs as a child
  `pi --mode rpc` (`mu delegates run`), with the same admission, queue, refusal and cancel.
- **`mu next` and `mu task auto`.** Explicit, host-fenced permission for judgement-free
  moves: `mu next` recovers dead or errored workers and spawns ready ones, with
  `--dry`, `--hold`, `--cap` and `--workers`. It never accepts or merges.
- **Task graph.** `mu task add` takes several ids and `--blocks`; `--triage` and
  `mu task accept` keep review findings out of `next` until accepted; `mu task open`;
  `--if <rev>` guards; `mu human-needed <reason>` records the loop's one legitimate
  stop for a person's decision.
- **Remote workers.** `mu host add|list|show|rm|init|check` store ssh-free host
  profiles; `mu agent spawn --host <profile> [--worktree] --task <id> --send ...`
  starts a remote worker; `mu agent collect` brings its commits home; a remote
  recovery record keeps a removed worker's worktree reachable.
- **Exact agent control.** `mu agent send` returns a receipt (`msgId`, `incarnation`,
  `delivery`); `mu agent check <agent> <msgId>` settles an unknown delivery;
  `mu wait agent:<name>#<incarnation>` refuses a restarted pi; every control-socket op
  is fenced to the incarnation the caller saw.
- **`mu wait` armed by what you started.** `spawn --send`, `spawn --task`, `send` and
  `task claim --for` register what the next bare `mu wait` owes; the extension's settle
  wait keeps an orchestrator driving until nothing is owed or a human stop is open.
- **A live dashboard.** Bare `mu` on a TTY opens a read-only ink dashboard: Overview,
  Tasks, DAG, Agents and Log tabs, drills into notes, scrollback and log entries,
  workstream switch, filters, `y` yank over OSC 52, `a` attach. It polls, never writes,
  and runs ambient sync on its own connection.
- **Sync and recovery.** The ops-capture triggers live in the DB file, so any plain write
  is captured; `mu rebuild` replays the ops log into a new DB from one snapshot;
  `mu db backup|compact|forget`; `mu doctor` rows for `mu ext`, `ctl` and the DB.
- **The skill and recipes.** One capped `mu` skill, twelve recipes and nine pi prompts
  (`/ultrathink`, `/mu-review`, `/mu-refute`, ...), measured against an eval matrix.
  A due course check shows as a notice on `mu state` and `mu wait`.
- **Guides.** [Run mu with other agent CLIs](../guide/other-agent-clis.md): pin which
  `mu` a codex or cursor-agent shell runs, start a tmux worker with its prompt as an
  argument, and what works with no multiplexer.
- **Docs for 4.0.** The README states 4.0 and shows the dashboard
  (`docs/img/tui-dashboard.png`, drafted by `tools/screenshot/dashboard.sh`).
  The upgrade guide covers 3.x to 4.0, keeping 3.x runnable for the Move
  recipe, and rollback. `MU_TMUX_SOCKET` is documented as a private-server
  switch, and the remote guide says which wait applies a `CLOSE:` block.

### Changed

- **Worktrees replace workspaces.** `mu agent spawn <name> --worktree` runs
  `git worktree add --detach` under the state dir; the pane's cwd is the worktree.
  `agents.cwd` and `agents.base` record where and from which commit.
- **Task claims and closes carry evidence.** `task close --as done` needs `--evidence` (or `--note`);
  a worker's `CLOSE:` block closes its task, and a malformed one ends a wait with a
  reason instead of hanging it.
- **`mu agent wait` on a non-pi agent fires only on busy to not busy**, as in 3.x: with
  no murmur state it runs to its timeout, so wait on `task:` refs.

### Test health

- Fast tier 217 files / 4720 tests, full suite 302 / 5691 (3 environmental skips), all
  green at the surface milestone; both gate budgets were over on the shared host
  ([record](../test-health/2026-10-23-surface.md)).

### Pre-release review

- Eight review rounds (sync, waits, worktrees and spawn, CLI surface, dashboard,
  test harness, exit codes, docs) landed 29 fix entries covering 36 findings. The
  user-visible breaks are in Breaking above.
