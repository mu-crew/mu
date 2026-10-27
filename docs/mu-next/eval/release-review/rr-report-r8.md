# Release review r8: docs (tree /var/tmp/rr @ a0872c7)

## Scope covered
README.md, AGENTS.md, CHANGELOG.md ([Unreleased] in full for reverted or dev-only content; older releases skimmed),
docs/ARCHITECTURE.md, docs/VISION.md, docs/ROADMAP.md, docs/VOCABULARY.md, docs/guide/* (all 13), docs/reference/env.md,
docs/reference/naming.md, docs/architecture/{mux,control-socket,sync,sdk} (dag and ops-log skimmed), skills/mu/SKILL.md,
all 12 recipes, all 9 prompts.

## What I checked
- Prose claims against `--help` and src: the wait, send, spawn, next, sql, delegates, doctor, host, log and notes surfaces, exit codes, table and view counts
  (26 tables, 4 views, schema 13: all correct), MuxBackend method list, agent-state reasons, env vars (both directions:
  every MU_/PI_ var in src is documented, every documented var exists), and every src/test path the docs name (`test -e`).
- Ran the built CLI on an isolated DB and a private tmux socket: quick start and getting-started steps, `task next` output on a TTY,
  `mu doctor` row names, MU_MUX=bogus (exit 1), no-mux behaviour (env -i: state/init/agent list exit 5, log works),
  delegate register with MU_SYNC_DIR set (the brief lands in the segment), and both course-correct SQL queries (they run).
- Reverted designs: rg for alsoFiring, read-delivers, pane-env, MU_PANE_ENV and consumeReadReport across the docs.
- Release path: CHANGELOG section size against release.yml's `gh release create`.
- docs-cli-drift, doc-links and prose-budget tests: all green (97 tests).
- Unslop scan: no AI-isms found; AGENTS.md uses em-dash separators (P3).

## Findings (all OPEN/triage in next-build)
- rr_r8_changelog_release_size: P2. The 4.0 section is 178k chars, over GitHub's 125k body limit. release.yml publishes to npm first,
  then `gh release create` fails. The section also reads as dev history ("SDK only ... until v_hint_wire", dogfood kits).
- rr_r8_changelog_pane_env_reverted: P2. CHANGELOG:69 still describes MU_PANE_ENV, PaneEnvMismatchError and MU_ALLOW_FOREIGN_DB.
  All of it was reverted in ac68e08. (rr_r2_reverted_changelog covers only :74-75.)
- rr_r8_delegate_ops_log_claim: P2. README, guide/delegate.md and findings.md say delegate-only reviews leave nothing in the ops log.
  In fact every call's brief and answer are scratch-task ops that sync (repro shown in the task).
- rr_r8_getting_started_output: P2. The tutorial shows a box table for `task next`, but the command prints a TSV record.
  The doctor row is named "mu ext", not "ext".
- rr_r8_vision_stale_claims: P2. VISION says a multiplexer is required, describes the removed 3.x TUI (clipboard-and-exit,
  reconcile, lazygit), lists execa as a dependency, says the delegate answer is echoed into the conversation, and gives a stale 99k LOC count.
- rr_r8_execa_unused_dep: P2. execa sits under `dependencies` but only tests import it.
- rr_r8_agents_md_stale: P2. AGENTS.md traps name deleted TUI files, a removed `--via mux` flag, "workspace", and 3.x task-wait commit
  listing. The Gates "Today" numbers contradict the same-day test-health record.
- rr_r8_upgrade_guide_mu_next: P2. upgrade.md, the README status, move.md, sync.md, env.md and ROADMAP still describe an unreleased
  mu-next beside 3.x. No doc shows how to keep 3.x runnable after `npm i -g @mu-crew/mu@latest`.
- rr_r8_arch_roadmap_drift: P2. ARCHITECTURE says "Four tabs". control-socket.md says mu_delegate is hidden without a mux.
  ROADMAP cites a SKILL.md exception note, a review-panel recipe and a paste path, none of which exist.
- rr_r8_p3_batch: P3, 9 items. Includes the auth-refator typo in the rename recipe, a garbled tally sentence, the undefined
  "mule", stale VISION counts and a v10 peer reference.

Coordination: the upgrade, mu-next and ROADMAP items overlap readme_mu4 and release_cleanup step 3, but name files those tasks
do not list (upgrade.md body, move.md, env.md, sync.md, VISION). Merge them there if preferred.

## Not covered
- docs/mu-next/** and docs/history/** (excluded), docs/specs/**, docs/test-health/** (used only as evidence).
- CHANGELOG entries for 3.x and older: not checked line by line.
- VOCABULARY's long mu-next term table: spot-checked, not verified row by row against code.
- docs/architecture/ops-log.md and dag.md: skimmed, not fact-checked in depth. Recipe advice (models tiers, test-health) not judged.
- Runtime behaviour of pi-side flows (settle wait, wake, remote host): checked against docs and code only, not run.
- Filed with installed mu 3.13.3 (`--triage`); it has no `task triage` verb, so the tasks are in OPEN/triage.
