// The dashboard entry. Loaded ONLY by `src/cli/dashboard-launch.ts` through a
// dynamic import: ink and react stay out of every other verb and out of the SDK
// index. Never import `../../cli.js` from here (import-cycle trap).

import { type Instance, render } from "ink";
import { createElement } from "react";
import { spawnerFromEnv } from "../../agents/spawn.js";
import type { Db } from "../../db.js";
import { resolveMuxSessionWorkstreamName } from "../../workstream.js";
import type { Shutdown } from "../dashboard-shutdown.js";
import { App } from "./app.js";
import { createRuntime } from "./runtime.js";

export interface RunDashboardOptions {
  dbPath: string;
  /** The writable connection ambient sync runs on (see runtime.ts). */
  syncDb: Db;
  /** The launcher's teardown; this registers render and runtime steps on it. */
  shutdown: Shutdown;
  /** `-w`; else the mux session's workstream; else the most recently active one. */
  initialWorkstream?: string;
  /** The fast tick in ms (default 1000; `+`/`-` change it live). */
  pollMs?: number;
}

/**
 * Run the dashboard until q/Esc/Ctrl-C. Teardown is the launcher's `shutdown`
 * (signals, errors and this return all end in it); this only registers steps.
 */
export async function runDashboard(opts: RunDashboardOptions): Promise<void> {
  const runtime = createRuntime({
    dbPath: opts.dbPath,
    syncDb: opts.syncDb,
    caller: spawnerFromEnv(),
  });
  let app: Instance | undefined;
  // Steps run in order: restore the terminal first, then drain and close.
  opts.shutdown.add(() => app?.unmount());
  opts.shutdown.add(() => runtime.close());
  app = render(
    createElement(App, {
      runtime,
      initialWorkstream:
        opts.initialWorkstream ?? (await resolveMuxSessionWorkstreamName()) ?? undefined,
      pollMs: opts.pollMs ?? 1000,
    }),
    { alternateScreen: true, interactive: true },
  );
  await app.waitUntilExit();
}
