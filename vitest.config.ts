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

export function suiteConfig(maxWorkers: number, { fast = false } = {}) {
  return defineConfig({
    test: {
      include: ["test/**/*.test.ts"],
      environment: "node",
      pool: "forks",
      // Serial for the full run (`npm run test`): the integration files share
      // the run's one private tmux server (test/_global-teardown.ts), which
      // stalls under parallel forks. The fast tier runs in parallel.
      // MUZZLE_SLOTS is not read here: one worker fits any admission.
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
      exclude: [
        ...configDefaults.exclude,
        ...(fast ? ["**/*.integration.test.ts"] : []),
        ...pureTests,
      ],
      // globalSetup (test/_global-teardown.ts) starts the run's private
      // `tmux -L <socket>` server, builds the DB template, makes the per-run
      // scratch dir, and after the run removes all of it. The server
      // watchdog only cleans endpoints this run registered.
      globalSetup: ["./test/_global-teardown.ts", ...(fast ? [] : ["./test/_git-setup.ts"])],
      // Per-fork pre-test setup: scrub MU_* env vars inherited from
      // the parent shell so SDK-level overrides (MU_PI_COMMAND,
      // MU_IDLE_THRESHOLD_MS, …) can't silently change behaviour
      // underneath tests. See test/_setup.ts for the rationale.
      setupFiles: [
        "./test/_setup.ts",
        "./test/_setup-db.ts",
        // Fast tier: a test that starts git fails (test/_setup-no-git.ts).
        ...(fast ? ["./test/_setup-no-git.ts"] : []),
      ],
      // 30s is ~15x the isolated cost of a tmux/subprocess test: a real hang
      // still fails fast, transient load does not. A test that needs longer
      // sets `{ timeout: N }`.
      testTimeout: 30000,
    },
  });
}

export default suiteConfig(1);
