import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    // vitest 4 removed poolOptions; the pool-specific knobs are top-level
    // now. singleFork:true becomes a one-worker cap.
    // One worker for the full run (`npm run test`). The integration files
    // drive real tmux panes and git; they share the run's one private tmux
    // server (test/_global-teardown.ts) and a loaded box stalls
    // it for tens of seconds when several forks hit it at once (the
    // cross-workstream reaper test took 431ms alone, 30s+ in parallel).
    // The fast tier (vitest.fast.config.ts) has no real mux and runs in
    // parallel. `--maxWorkers=2` was measured green
    // (docs/test-health/2026-10-23-surface.md §3); serial is kept for
    // determinism, and it is why the slow tier is near its budget.
    maxWorkers: 1,
    // globalSetup (test/_global-teardown.ts) starts the run's private
    // `tmux -L <socket>` server, builds the DB template, makes the per-run
    // scratch dir, and after the run removes all of it. It also sweeps
    // leaked `mu-*` sessions on the default socket, and what a killed
    // earlier run left behind (its server, socket file and scratch dir).
    globalSetup: ["./test/_global-teardown.ts"],
    // Per-fork pre-test setup: scrub MU_* env vars inherited from
    // the parent shell so SDK-level overrides (MU_PI_COMMAND,
    // MU_IDLE_THRESHOLD_MS, …) can't silently change behaviour
    // underneath tests. See test/_setup.ts for the rationale and
    // the allowlist (MU_TMUX_SOCKET is preserved). Layer "test" of
    // bug_test_flake_round_2.
    setupFiles: ["./test/_setup.ts", "./test/_setup-db.ts"],
    // Integration tests spawn real tmux panes + sh subprocesses and poll
    // for state to propagate (reaper flips, pane death, claim CAS). Each
    // takes <2s alone, but a loaded box can push one past vitest's 5000ms
    // default (testreview_wait_5s_default_timeout_flake). 30000ms is ~15x
    // the isolated cost: a real hang still fails fast, transient load does
    // not. A test that needs longer sets `{ timeout: N }`.
    testTimeout: 30000,
  },
});
