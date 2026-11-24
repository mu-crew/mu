import { cpus } from "node:os";
import { suiteConfig } from "./vitest.config.js";

/**
 * The pre-commit suite: no tests requiring a real mux or Git.
 *
 * Runs in PARALLEL. The base config pins `maxWorkers: 1` for the
 * `*.integration.test.ts` files that share the run's private tmux server; the
 * fast tier has no such constraint. Module loading serialised behind a
 * one-worker cap was most of the cost (import time is paid per file), so the
 * pool is sized from the machine rather than pinned. Pass a real numeric cap
 * to both projects: an undefined override leaves the full suite's inherited
 * cap in place.
 *
 * Under muzzle the admitted slot count wins: `MUZZLE_SLOTS` (min 1) is the
 * share of the host muzzle granted this run, and each fork is a process tree.
 * Where every exec goes through endpoint-security agents the bottleneck is
 * process starts, not CPU, so eight forks under a two-slot admission starved
 * the machine.
 */
const slots = Number(process.env.MUZZLE_SLOTS || Number.NaN);
const workers = Number.isFinite(slots)
  ? Math.max(1, Math.floor(slots))
  : Math.max(2, Math.min(8, Math.floor((cpus().length || 4) / 2)));

export default suiteConfig(workers, { fast: true });
