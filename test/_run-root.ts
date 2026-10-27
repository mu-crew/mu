// `provide`/`inject` key the per-run scratch dir travels under.
//
// globalSetup (test/_global-teardown.ts) creates `<tmpdir>/mu-test-run-<pid36>-*`
// once, and teardown() removes it. Forks put their XDG roots inside it
// (test/_setup.ts). Kept apart from _global-teardown.ts because importing that
// file runs its module-load side effects (it publishes MU_TMUX_SOCKET).
export const RUN_ROOT_KEY = "muRunRoot";
