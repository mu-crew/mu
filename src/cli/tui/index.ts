// The dashboard entry. Loaded ONLY by `src/cli/dashboard-launch.ts` through a
// dynamic import: ink and react stay out of every other verb and out of the SDK
// index. Never import `../../cli.js` from here (import-cycle trap).

import { render } from "ink";
import { createElement } from "react";
import { spawnerFromEnv } from "../../agents/spawn.js";
import type { Db } from "../../db.js";
import { App } from "./app.js";
import { createRuntime } from "./runtime.js";

export interface RunDashboardOptions {
  dbPath: string;
  /** The writable connection ambient sync runs on (see runtime.ts). */
  syncDb: Db;
  initialWorkstream?: string;
  /** Poll gap in ms (default 2000). */
  pollMs?: number;
}

/** Run the dashboard until q/Esc/Ctrl-C. Closes both connections and flushes. */
export async function runDashboard(opts: RunDashboardOptions): Promise<void> {
  const runtime = createRuntime({
    dbPath: opts.dbPath,
    syncDb: opts.syncDb,
    caller: spawnerFromEnv(),
  });
  try {
    const app = render(
      createElement(App, {
        runtime,
        initialWorkstream: opts.initialWorkstream,
        pollMs: opts.pollMs ?? 2000,
      }),
      { alternateScreen: true, interactive: true },
    );
    // A terminal hangup or kill unmounts like q does, so the final flush runs.
    const stop = (): void => app.unmount();
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    try {
      await app.waitUntilExit();
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
    }
  } finally {
    await runtime.close();
  }
}
