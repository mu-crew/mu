// `provide`/`inject` key the per-run scratch dir travels under.
//
// The global setup creates one short root for both workers and test servers.
// The server watchdog removes it even if the runner is killed.
export const RUN_ROOT_KEY = "muRunRoot";
