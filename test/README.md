# Test conventions

Test conventions. Start with the tiers, then [mux tests](#mux-tests) (which seam).

## Tiers

| Tier | Files | Runs | Rules |
| --- | --- | --- | --- |
| fast | `*.test.ts` | `npm run test:fast`, parallel | in-process: mocked mux and VCS, per-test temp DBs, no real tmux/git/jj/sl, no sleeps over 50ms |
| integration | `*.integration.test.ts` | `npm run build && npm run test`, one worker | may use real tmux (the run's private `-L` server), herdr (named session), Rex (a private server), VCS fixtures, subprocesses; some need `dist/` |

The tmux integration tests do **not** need `$TMUX`: `globalSetup` starts a
private server and provides its socket to workers as `MU_TMUX_SOCKET`, and `tmuxIntegrationAvailable()`
is true whenever that is set. They skip only if that server failed to start
(the setup prints a warning). `test/_setup.ts` points `TMPDIR` into the run's short server root (`/tmp/mus-*`,
unix socket paths cap at 104 bytes), so the watchdog removes worker scratch
even when a fork is killed before `afterEach`.

`_setup-no-git.ts` (fast tier only) puts a `git` shim first on PATH: any fast
test that starts git, by any route, fails with the argv. Use a VCS mock or move
the test to integration.

Both tiers use the same `pure` Vitest project for the allowlist in
`vitest.config.ts`. Its files share a fork and run without fixture setup:
keep module mocks, DBs, subprocesses and env/cwd mutations in `isolated`.

`registerFixturePlugin` runs setup-only handshakes over pipes in process.
`withPluginPipes` can also script read replies, with notifications in the same chunk.
Keep real children for effect dispatch, child I/O, startup and shutdown.

## Mux tests

mu drives three multiplexers (`tmux`, `herdr`, `rex`) behind the `MuxBackend`
interface. Which tier your test belongs to is decided by one question:
**does it need a real multiplexer?**

### Fast tier — `*.test.ts`, use `installMux()`

Almost every mux test belongs here. `test/_mux.ts` is the seam: one call
installs the backend *and* stubs that backend's executor, and returns a
single `restore()`.

```ts
import { installMux, type MuxHarness } from "./_mux.js";
import { PANE_LIST, WORKSPACE_LIST } from "./_mux-fixtures.js";

let harness: MuxHarness | undefined;
afterEach(() => {
  harness?.restore();
  harness = undefined;
});

it("lists panes", async () => {
  harness = installMux("herdr", [
    ["workspace list", WORKSPACE_LIST],
    ["pane list", PANE_LIST],
  ]);
  expect(await listPanes("mu-topotest")).toHaveLength(2);
  expect(harness.argsOf(0)).toEqual(["workspace", "list"]);
});
```

- Routes are **prefix-matched** against the space-joined args vector;
  first match wins, so order narrow routes before broad ones. An
  unrouted call returns exit 1 with `unrouted: <cmd>` in stderr — a real
  substrate failure, naming the route you forgot.
- Pass a **function** instead of a routing table for stateful stubs or
  to assert a code path never shells out (`throw` inside it).
- Canned responses live in `test/_mux-fixtures.ts` — verbatim captures
  from a real herdr server. Import them; never re-inline a payload in a
  test file, or the recordings drift apart file by file.
- `installUnreachableMux(backend, errFactory)` models a box with **no**
  multiplexer: every method rejects. Use it to prove load-bearing call
  sites propagate `NoMultiplexerError` and best-effort ones degrade.

Fast-tier rules from AGENTS.md apply unchanged: no real subprocess, no
sleeps >50ms, per-test temp DBs only.

### Integration tier — `*.integration.test.ts`, must self-skip

Only when the test genuinely needs the real substrate. Gate on the
helpers in `test/_mux.ts`:

| Backend | Gate | Isolation |
| --- | --- | --- |
| tmux | `tmuxIntegrationAvailable()` (the private socket is up; `$TMUX` is not needed) | **Structural** — `MU_TMUX_SOCKET` points the suite at a private `-L <socket>` server (see `_global-teardown.ts`) |
| herdr | none — herdr tests are explicit-only | **Explicit** — `MU_HERDR_SESSION` names a private session; there is no private-socket equivalent |
| rex | `rex version` runs (`test/mux-rex.integration.test.ts`) | **Structural** — `startTestRex()` starts an isolated Rex server and returns its address for `MU_REX_SERVER` |

Register any extra tmux socket with `registerTmuxSocket()` before using it;
stop it with `stopTestTmux()` in the fixture hook. For Rex, call `stop()` on
its fixture in the hook. Global teardown uses the same per-run registry
as a backstop. If a deadline kills Vitest before its hooks run, the cleanup
process sees the runner's pipe close and stops the registered servers. It
never scans the user's tmux sockets or stops a Rex server by name alone.

### ⚠️ The herdr blast shield

tmux gets a private socket, so a buggy tmux test is contained. **herdr
has no such backstop.** Its only isolation is `--session <name>`, which
mu routes to via `MU_HERDR_SESSION`. A herdr test that reaches the
*default* session destroys the user's real panes, the agents in them,
and their unsaved work. There is no undo, and no sweep can distinguish a
user pane from test residue.

Therefore, non-negotiably:

- **Never** run `herdr server stop` / `restart` / `kill` from the suite,
  and never kill the main herdr process. These are shared-fate: mu
  cannot rely on them being session-scoped, so they are banned even
  inside a correctly isolated session.
- **Never** touch the `default` session.
- Clean up **per-entity** (close the workspaces your test created), not
  by nuking a server.
- Route real herdr commands through **`herdrTestExec()`**. It calls
  `assertHerdrIsolated()` on every invocation — refusing to run when
  `MU_HERDR_SESSION` is unset, empty, or `default` — and rejects the
  fatal verbs before spawning anything. Get a unique session name from
  `freshHerdrSession()`.

These guards are runtime assertions, not comments, and
`test/mux-test-seam.test.ts` exercises them. That is deliberate: a
safety rule nobody has executed is a wish.

There is no server-wide herdr cleanup. The fixture closes only the
workspaces it created.
