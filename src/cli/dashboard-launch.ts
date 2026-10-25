// Bare `mu`: open the dashboard on a TTY, print help everywhere else.
//
// The dashboard is for a human at a terminal. A pipe, `--json`, a script or CI
// get the same help as before, so nothing that parsed `mu` output changes.
// The UI (ink, react) is a lazy import, paid only here.

import type { Command } from "commander";
import { defaultDbPath } from "../db.js";
import { isJsonMode } from "../output.js";
import { withShutdown } from "./dashboard-shutdown.js";
import { handle } from "./handle.js";

/** Both ends a TTY and not `--json`. */
export function dashboardLaunchable(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true && !isJsonMode();
}

/** The root command's action: dashboard when launchable, else help. */
export function openDashboardOrHelp(program: Command): () => Promise<void> {
  // `handle` does the guards (DB inside MU_SYNC_DIR, sync/v1 dir), opens the
  // writable connection and maps typed errors. Ambient sync is the dashboard's
  // own (quiet, bounded, see tui/runtime.ts), so the generic hook is off and
  // `withShutdown` owns the final flush for every way out, from before the lazy
  // import on (a failing import or RO open still publishes this machine's ops).
  const run = handle(
    (syncDb) =>
      withShutdown(syncDb, async (shutdown) => {
        const { runDashboard } = await import("./tui/index.js");
        const first = (program.opts() as { workstream?: string[] }).workstream?.[0];
        await runDashboard({ dbPath: defaultDbPath(), syncDb, shutdown, initialWorkstream: first });
      }),
    program,
    { ambientSync: false },
  );
  return async () => {
    if (dashboardLaunchable()) await run();
    else program.outputHelp();
  };
}
