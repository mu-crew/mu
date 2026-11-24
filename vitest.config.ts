import { configDefaults, defineConfig } from "vitest/config";

// Explicit allowlist: no DB/mux setup, module mocks, env/cwd mutations or
// subprocesses. Reuse forks here only; everything else stays file-isolated.
// The pure project is `extends: false`, so it intentionally omits the isolated
// project's guards: no globalSetup (private tmux server, DB template), no
// setupFiles (`_setup.ts` MU_* scrub, `_setup-db.ts`) and no per-file isolation.
// Allowlisted files must not need any of them. It does set the same
// testTimeout, so a cold import on a loaded host cannot trip the 5s default.
const pureTests = [
  "channel-imports",
  "channel-names",
  "cli-find-command-for-argv",
  "cli-input-property",
  "cli-task-sort",
  "close-block",
  "compare",
  "delegate-outcome",
  "eval/agent-rules",
  "eval/events",
  "eval/exposure",
  "eval/provenance",
  "eval/report",
  "eval/stats",
  "eval/tournament-help-markers",
  "fold",
  "host-imports",
  "index-exports-errors",
  "link-imports",
  "log-render",
  "log-render-intent",
  "no-eager-execa",
  "no-scrape",
  "plugin-imports",
  "plugin-job-wire",
  "plugin-schema",
  "sha256-resumable",
  "tasks-sort",
  "tasks-substate-vocab",
  "unescape-note-text",
  "wait-regex",
].map((name) => `test/${name}.test.ts`);

export function suiteConfig(maxWorkers: number, exclude: string[] = []) {
  return defineConfig({
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
      // MUZZLE_SLOTS is not read here: one worker already fits any admission
      // (muzzle grants at least one slot).
      maxWorkers,
      projects: [
        { extends: true, test: { name: "isolated" } },
        {
          extends: false,
          test: {
            name: "pure",
            include: pureTests,
            isolate: false,
            pool: "forks",
            maxWorkers,
            testTimeout: 30000,
          },
        },
      ],
      exclude: [...configDefaults.exclude, ...exclude, ...pureTests],
      // globalSetup (test/_global-teardown.ts) starts the run's private
      // `tmux -L <socket>` server, builds the DB template, makes the per-run
      // scratch dir, and after the run removes all of it. The server
      // watchdog only cleans endpoints this run registered.
      globalSetup: ["./test/_global-teardown.ts"],
      // Per-fork pre-test setup: scrub MU_* env vars inherited from
      // the parent shell so SDK-level overrides (MU_PI_COMMAND,
      // MU_IDLE_THRESHOLD_MS, …) can't silently change behaviour
      // underneath tests. See test/_setup.ts for the rationale.
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
}

export default suiteConfig(1);
