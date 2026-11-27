// Global per-fork test setup. Every fork starts from a known-clean env:
//
// - Every MU_* var is deleted (a developer's shell exporting MU_PI_COMMAND or
//   MU_IDLE_THRESHOLD_MS would silently change SDK behaviour under every
//   test). Tests that need one opt IN with `process.env.X = ...` or
//   `withEnv()`. tmux settings come from this run's global setup, not
//   the parent shell.
// - XDG_CACHE_HOME / XDG_STATE_HOME / XDG_CONFIG_HOME point at a per-fork dir
//   under the per-run scratch dir that globalSetup creates and removes
//   (test/_global-teardown.ts): forks are killed without their "exit"
//   handlers, so a per-fork mkdtemp + exit cleanup leaked a dir per fork.
//   test/_real-dir-guard.ts throws on a write that still targets the real dirs.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { inject } from "vitest";
import { setTtyWriterForTests } from "../extension/delegate-osc.js";
import { setPaneOptionRunnerForTests } from "../extension/delegate-pane-option.js";
import { setLocalLaunchFlagsForTests } from "../src/agents/spawn-presets.js";
import {
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import { sandboxMarkerEnvNames } from "../src/harnesses.js";
import { setProcessTableReaderForTests } from "../src/hook-chain.js";
import { setMuzzleRunnerForTests } from "../src/muzzle-queue.js";
import { installRealDirGuard, realMuDirs } from "./_real-dir-guard.js";
import { RUN_ROOT_KEY } from "./_run-root.js";
import { setServerRoot, TMUX_SOCKET_KEY } from "./_server-registry.js";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("MU_")) {
    delete process.env[key];
  }
}

const runRoot = inject(RUN_ROOT_KEY);
if (typeof runRoot === "string") setServerRoot(runRoot);
const socket = inject(TMUX_SOCKET_KEY);
if (typeof socket === "string") process.env.MU_TMUX_SOCKET = socket;
// A bare tmux command must not follow the parent shell to a foreign socket.
for (const key of ["TMUX", "TMUX_PANE"]) delete process.env[key];

// A test run from inside a pi session inherits its identity: `mu wait` would own
// (and spawn would stamp) a real session's work. Tests that need one set it.
{
  const key = "PI_SESSION_ID";
  delete process.env[key];
}

// A run from inside an agent (Claude Code, Codex, …) inherits its sandbox marker
// env, and spawn would refuse to start a tmux server there (spec D10). Tests
// that need a marker set it.
for (const key of sandboxMarkerEnvNames()) {
  delete process.env[key];
}

// A run from inside a Rex pane inherits its location: detection would pick Rex,
// and the rex backend would drive the user's real server. Rex tests set theirs.
for (const key of ["REX_SESSION", "REX_BLOCK", "REX_SERVER", "REX_BIN_DIR", "REX_CLIENT"]) {
  delete process.env[key];
}

// Baseline: tmux is the mux. Detection otherwise needs an ambient $TMUX /
// $TMUX_PANE (a shell inside tmux) or a working `tmux -V`; the files that mock
// the tmux executor answer neither, so they failed from a plain shell or SSH
// session (rr_r6_tmux_gate_env). Tests of detection itself clear MU_MUX
// (test/mux-detect.test.ts); Rex tests set theirs.
process.env.MU_MUX = "tmux";

// Baseline: no real muzzle. An agent read off ctl asks `muzzle status --json`
// whether its pane is queued (spec D14); the fast tier spawns no subprocess,
// and a developer's own queue must not leak in. test/muzzle-queue.test.ts
// scripts it.
setMuzzleRunnerForTests(async () => null);
// Delegate OSC 7501 records must not reach the developer's terminal.
setTtyWriterForTests(() => {});
// ...nor `@mu_pending` a real tmux pane: the fast tier spawns no tmux.
setPaneOptionRunnerForTests(async () => undefined);

// Baseline: no local launcher takes a launch flag (codex's `--no-daemon`), so no
// test runs the machine's own `codex --help`. test/spawn-presets.test.ts probes
// fake launchers on PATH.
setLocalLaunchFlagsForTests(() => []);

// Baseline: no real murmur pane. The hooks channel's send gate and ack ask
// `murmur pane <pane> --json`, which drains the developer's real inbox; the
// fast tier spawns no subprocess. test/channel-contract.test.ts drives a fake
// harness through it. Likewise `murmur hook mu`, which writes into that inbox.
setMurmurPaneRunnerForTests(async () => null);
setMurmurHookRunnerForTests(async () => false);

// Baseline: no real process table for `mu hook stop`. Its walk reads anchors
// under the real HOME, where a developer's own mu panes live; a test run from
// such a pane would act as that agent. test/hook-stop.test.ts injects tables.
setProcessTableReaderForTests(() => null);

// Baseline: no spawn-time control-socket handshake. No test pane runs
// the mu pi extension, so the 30s default would stall every pi spawn.
// test/spawn-ctl.test.ts opts back in with a small budget.
process.env.MU_SPAWN_CTL_MS = "0";

// Baseline: no moved harness config. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` move
// where `mu init` writes and `mu doctor` reads, past MU_INIT_HOME, so a
// developer's own would take a test's writes into their real config. Tests
// that need one pass it in an env object or set it.
for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
  delete process.env[key];
}

// Real dirs first (from the inherited env), then redirect, then guard.
const realDirs = realMuDirs();
let xdgRoot: string;
if (typeof runRoot === "string") {
  // Every mkdtemp(tmpdir()) lands under the watchdog's short run root,
  // even when a fork dies before afterEach.
  const scratch = join(runRoot, `t${process.pid}`);
  xdgRoot = join(runRoot, `xdg-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(xdgRoot, { recursive: true });
  process.env.TMPDIR = scratch;
} else {
  // No globalSetup (a custom config): fall back to a per-fork dir.
  xdgRoot = mkdtempSync(join(tmpdir(), "mu-test-xdg-"));
  process.on("exit", () => {
    try {
      rmSync(xdgRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
}
// Neither migration nor init sees the developer's harness config.
process.env.MU_PI_HOME = join(xdgRoot, "no-pi-home");
process.env.MU_INIT_HOME = join(xdgRoot, "no-init-home");
process.env.XDG_CACHE_HOME = join(xdgRoot, "cache");
process.env.XDG_STATE_HOME = join(xdgRoot, "state");
process.env.XDG_CONFIG_HOME = join(xdgRoot, "config");
installRealDirGuard(realDirs);

// Baseline: a `pi` on PATH. spawn refuses a harness binary it cannot find
// (AgentSpawnCliNotFoundError), and most spawn tests use the default `--cli pi`
// against a mocked mux, so they assumed the host had pi installed. The stub
// goes LAST on PATH: a developer's real pi still wins. On a bare host (CI) the
// stub passes the binary check and fails at once if anything RUNS it (a real
// tmux pane): a stub that waited would hang every test that waits on pi.
// Tests that pin "not on PATH" set PATH themselves.
{
  const stubBin = join(xdgRoot, "stub-bin");
  mkdirSync(stubBin, { recursive: true });
  const stub = join(stubBin, "pi");
  writeFileSync(
    stub,
    '#!/bin/sh\necho "pi: test stub (test/_setup.ts), no real pi on this host" >&2\nexit 127\n',
  );
  chmodSync(stub, 0o755);
  process.env.PATH = `${process.env.PATH ?? ""}${delimiter}${stubBin}`;
}
