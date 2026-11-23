// `provide`/`inject` key the per-run scratch dir travels under.
//
// globalSetup (test/_global-teardown.ts) creates it once under tmpdir()
// and teardown removes it. Forks put their XDG roots inside it
// (test/_setup.ts). Keep this key independent of the global setup hook.
export const RUN_ROOT_KEY = "muRunRoot";
