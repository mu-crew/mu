// The dashboard's ONE teardown path. `withShutdown` creates it and installs the
// process hooks BEFORE anything that can throw (the lazy ink import, the RO
// open, render), so every exit funnels through the same idempotent `run()`:
// SIGINT/SIGTERM/SIGHUP, an uncaught error, Ink's own exit and a boot error.
//
// Steps run in registration order (stop render, drain refresh + close the RO
// connection, ...), then the final sync flush ALWAYS runs last on the writable
// connection, even when no step was ever registered (boot failed early). The
// flush is quiet: a stderr write would paint over the alternate screen.

import type { Db } from "../db.js";
import { ambientFlush, syncEnabled } from "../sync.js";

export interface Shutdown {
  /** Register a teardown step. Errors in a step never stop later steps or the flush. */
  add(step: () => void | Promise<void>): void;
  /** Run teardown once; later and concurrent calls share the first run. */
  run(): Promise<void>;
}

const SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const;

export function createShutdown(syncDb: Db): Shutdown {
  const steps: Array<() => void | Promise<void>> = [];
  let done: Promise<void> | null = null;
  return {
    add: (step) => void steps.push(step),
    run() {
      done ??= (async () => {
        for (const step of steps) {
          try {
            await step();
          } catch {}
        }
        if (syncEnabled()) await ambientFlush(syncDb, { quiet: true });
      })();
      return done;
    },
  };
}

/**
 * Run `body` with the shutdown and the process hooks in place; whatever way it
 * ends (return, throw, signal, uncaught error) teardown has run by then.
 */
export async function withShutdown(
  syncDb: Db,
  body: (shutdown: Shutdown) => Promise<void>,
  exit: (code: number) => unknown = (code) => process.exit(code),
): Promise<void> {
  const shutdown = createShutdown(syncDb);
  const hooks: Array<[NodeJS.Signals | "uncaughtException", (...args: unknown[]) => void]> =
    SIGNALS.map(([sig, code]) => [sig, () => void shutdown.run().finally(() => exit(code))]);
  hooks.push([
    "uncaughtException",
    (err: unknown) =>
      void shutdown.run().finally(() => {
        console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
        exit(1);
      }),
  ]);
  for (const [event, fn] of hooks) process.on(event, fn);
  try {
    await body(shutdown);
  } finally {
    try {
      await shutdown.run();
    } finally {
      for (const [event, fn] of hooks) process.off(event, fn);
    }
  }
}
