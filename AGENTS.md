# Repo guide for AI coding agents

This repo builds **mu**: a CLI that runs AI agents in tmux or herdr
panes, coordinated through a task DAG.

## Read these first

1. [docs/guide/README.md](docs/guide/README.md) — what mu does for a user.
2. [CHANGELOG.md](CHANGELOG.md) — the upcoming version's entry is the
   source of truth for verbs, schema, and env vars.
3. [docs/VISION.md](docs/VISION.md) — design pillars you must not violate.
4. [docs/ROADMAP.md](docs/ROADMAP.md) — what's next and the promotion
   criteria. Read [Anti-feature pledges](docs/ROADMAP.md#anti-feature-pledges)
   before you add a dependency, an abstraction, or a surface.
5. [docs/VOCABULARY.md](docs/VOCABULARY.md) — canonical terms for code,
   docs, and error messages. [docs/reference/](docs/reference/) holds env vars and naming.
6. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the module map (what
   lives where in `src/`), plus deep dives under [docs/architecture/](docs/architecture/).

## Build, test, lint

```bash
npm install
npm run build            # tsup → dist/
npm run typecheck
npm run lint
npm run test:fast        # unit tier; safe to run concurrently
npm run test             # full suite, including integration
npm run test:stress      # pre-release stability gate
```

`tsc` is TypeScript 7 (fast typecheck). The `typescript` package is
aliased to 6.x on purpose: `tsup --dts` needs the programmatic API that
TS 7.0 lacks. Revisit at TS 7.1.

## Code style

- Strict TypeScript with `noUncheckedIndexedAccess`, ESM only. Use
  `unknown` instead of `any`, and early returns instead of `!`.
- Throw typed error classes (`AgentNotFoundError`, `CycleError`,
  `MuxError` and its `TmuxError` / `HerdrError` subclasses, …) so
  `handle()` maps each to an exit code.
- Auto-fix sort and format with `npx biome check --write src test`.
  Never add `--unsafe`: it rewrites `delete process.env.X` into
  `process.env.X = undefined`, which sets the string `"undefined"`.
  Delete env vars as `const key = "FOO"; delete process.env[key];`.
- Files cap at 1500 LOC. Refactor at 800.
- Layout is flat at the `src/` root. One level of subdirectory is
  allowed for a cohesive cluster: one theme, imports only from the
  cluster to root files, and a row in the ARCHITECTURE module map.

## Tests

- Unit tests use real SQLite in a temp dir and a mocked multiplexer.
  Install mocks with `installMux()` from `test/_mux.ts`: it sets the
  backend and its executor together and returns one `restore()`.
- TUI tests render through `test/_ink-render.ts` (see `test/README.md`).
- The fast tier (`*.test.ts`) stays in-process: mocked tmux and VCS,
  per-test temp DBs, no real tmux/git/jj/sl, no sleeps over 50ms.
- Name full-only tests `*.integration.test.ts`. They may use real
  tmux, herdr, VCS fixtures, or subprocesses. Real-tmux tests skip
  without `$TMUX`. Set `process.env.MU_SPAWN_LIVENESS_MS = "0"` in
  `beforeEach` when the spawned process is meant to live long.
- Integration tests use unique session names
  (`mu-test-<pid>-<ts>-<rand>`), poll (50ms × 10) instead of sleeping,
  and wrap `afterEach` cleanup in `try {} catch {}`. Unit tests call
  `setSleepForTests(async () => {})`.
- **Never stop the herdr server or kill its process from a test.** It
  destroys the user's real panes. herdr isolation is only a named
  session (`MU_HERDR_SESSION`, enforced by `assertHerdrIsolated()`), so
  close only what you created.
- `openDb()` refuses the real DB under vitest. Use `MU_DB_PATH` or
  `{ path }`.
- `test/_setup.ts` clears inherited `MU_*` vars except
  `MU_TMUX_SOCKET`. Opt in per test with `withEnv()` from `test/_env.ts`.
- `test/_global-teardown.ts` kills every `mu-*` tmux session on the
  default socket that has no workstream in your real DB.
- Workers run `npm run test` concurrently. A test that fails
  under load but passes alone is a test-infra concurrency bug (shared
  `/tmp`, sockets, leaked subprocesses). One that also fails alone is a
  real bug.
- `test/acceptance.integration.test.ts` is the end-to-end gate. Keep it
  green.

## Change rules

- **VOCABULARY first.** Add or rename a term in
  [docs/VOCABULARY.md](docs/VOCABULARY.md) before or with the code.
- **Roadmap gate.** Build only what is on the roadmap or meets all
  three promotion criteria: a real user hit the gap ≥2 times, the
  current design makes it straightforward, and it fits in <300 LOC.
  Otherwise add a ROADMAP entry and move on.
- **Commits:** one logical change each, scope prefix when useful
  (`schema: …`). The body says what changed and why, cites the VISION
  pillar or ROADMAP item, and states that the green gate passed. Add a
  [CHANGELOG.md](CHANGELOG.md) entry under the upcoming version.

## Common tasks

### Add a CLI verb

1. Write the SDK function (`src/agents.ts`, `src/tasks.ts`, …) with a
   typed result (`{ changed, previousStatus, … }`). Test with mocks.
2. Wire it in `src/cli.ts` with commander inside `handle(...)`. For
   `--workstream`, read `this.optsWithGlobals()`; the top-level option
   otherwise swallows it.
3. Document it in the matching `docs/guide/` how-to, VOCABULARY if
   it adds a term, and CHANGELOG. Remove any `mu sql` workaround it
   replaces. Touch `skills/mu/SKILL.md` only for a gotcha `--help`
   cannot state.
4. Smoke-test against real tmux, and on herdr with `MU_MUX=herdr` plus
   a private `MU_HERDR_SESSION` if it touches agents:

   ```bash
   MU_SYNC_DIR= MU_DB_PATH=/tmp/mu-smoke.db node dist/cli.js <verb> ...
   ```

   Blank `MU_SYNC_DIR` too. Otherwise the first flush writes the
   throwaway DB's `machine_id` into your real sync folder, and `mu sync`
   lists that phantom peer forever.

### Update the schema

The schema is v11 (`CURRENT_SCHEMA_VERSION` in `src/db.ts`), applied by
`applySchema(db)` as idempotent CREATE-IF-NOT-EXISTS. `openDb` refuses
older DBs (`SchemaTooOldError`) and newer ones (`SchemaTooNewError`),
both exit 4. There is no migration ladder.

1. Bump `CURRENT_SCHEMA_VERSION` and mirror the shape in
   `CURRENT_SCHEMA`. Prefer additive or idempotent-drop changes. Write
   a one-shot migration script only when neither works.
2. Classify every new table in `PORTABLE_TABLES` or
   `MACHINE_LOCAL_TABLES`. `test/entities.test.ts` fails otherwise.
3. Update `test/db.test.ts` and CHANGELOG `### Changed`.

### Add a multiplexer operation

Call sites use `await activeMux()` and never name a backend.

1. Add the method to `MuxBackend` (`src/mux/types.ts`) with a comment
   saying what it means.
2. Implement it in `src/mux/tmux.ts` and `src/mux/herdr.ts`. A backend
   with no equivalent no-ops instead of throwing.
3. If only one backend can do it, make it optional and branch on the
   method's presence, not on `mux.name`.
4. Let `NoMultiplexerError` propagate (exit 5) for load-bearing calls
   (spawn, send, kill). Wrap best-effort calls in try/catch, like
   `resolveWorkerIdentity` in `src/tasks/claim.ts`.

Run tmux only through `tmux(args)` and herdr only through
`herdr(args)`. pi agents are driven through the control socket, not
the multiplexer. For non-pi agents and `--via mux`, tmux needs the
bracketed-paste sequence in `sendToPane`, while herdr's `agent prompt`
is one atomic call. Keep the tmux workaround out of herdr.

## Known traps

- **Silent `node dist/cli.js --help`** with "Detected unsettled
  top-level await" is an import cycle: a file in `src/cli/tui/`
  imported `../../../cli.js`. Import from the real source module
  instead (`rg 'from "\.\./\.\./\.\./cli\.js"' src/cli/tui/`).
- **ANSI in ink `<Text>`** breaks wrap math. Pre-wrap by visual width
  with `src/cli/tui/wrap-ansi.ts` and pad lines to the box width.
- **A key or click lands in the wrong popup**: a stale mouse event was
  replayed. Consume it once, as `src/cli/tui/use-popup-action-queue.ts`
  does.
- **A hint for one popup** goes in its `hint` prop, not the global
  `POPUP_DRILL_HINTS`.

## Orchestrating on this repo

Follow [skills/mu/recipes/orchestrator-loop.md](skills/mu/recipes/orchestrator-loop.md). Repo specifics:

- Each workspace runs `npm install` into its own `node_modules`. Never
  symlink main's.
- `mu task wait` may list commits already on main when a worker forked
  from an old HEAD. Check `git log` in the workspace and cherry-pick
  only the new shas.
- CHANGELOG.md conflicts are routine: keep both halves in order.
  Resolve source conflicts by hand, never with `--ours` or `--theirs`.
- Fix a worker's bug in a separate commit after the cherry-pick. Do
  not amend it.
- Gate the merged tree with the full gate below plus
  `node dist/cli.js --help`.
- The installed `mu` may be older than the branch build. Confirm a
  worker received its brief (`mu agent read <w> -n 3`).

## Skill files are context, not documentation

`skills/mu/SKILL.md` loads into every orchestrator's context, and
the recipes in `skills/mu/recipes/` on demand. Every word competes with the
user's work. The recipes are written for an agent with no context;
[recipes/brief.md](skills/mu/recipes/brief.md) holds the rules, and
they apply to the skill files too.

- Leave verb lists, flags, and option tables to `--help`. The skill
  carries only what `--help` cannot: the gotcha, the reason, the trap.
- Say each thing once, next to where it applies.
- SKILL.md holds the trigger and the rule. Detail that only some
  branches need goes in a recipe under `skills/mu/recipes/`, with a
  row in SKILL.md's recipe index. Recipes reference only mu, never
  skills outside this repo.
- `docs/guide/` pages stay terse for humans and link to the recipe
  instead of restating it.
- Delete sentences the model obeys by default. State the target
  behaviour.

A commit that grows SKILL.md must say why. "The new verb needed
documenting" is not a reason.

## What not to do

- No config file. mu is CLI flags plus env vars.
- No daemon, watcher, or background process. Every invocation is
  short-lived.
- No abstraction without two real implementations today.
- No wrappers around wrappers, no JS-string codegen, no facade over
  SQLite (it is the canonical state; read it directly).
- No template or discovery system for agent roles.
- No render layer beyond `cli-table3` + `picocolors`, except `ink`
  inside `src/cli/tui/`. Never a second TUI stack.
- Don't bundle pi. It is an optional peer dependency.
- Write files only under `~/.local/state/mu/` or the repo.

## When you're done

```bash
npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build
```

Then check that VOCABULARY, ARCHITECTURE, and CHANGELOG reflect the
change.
