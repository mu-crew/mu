// R3 scan, R4 gate and the final holdout gate (spec docs/specs/2026-11-07-hill-r2-tournament.md
// §4.4-4.6). B3b ships the signatures the CLI calls; B3c (`tournament_gate`) replaces the bodies.
import type { Group } from "./nextstep.ts";

/** What every gate command gets from the CLI: the group, its row dir, the repo and its own args. */
export interface GateOpts {
  group: Group;
  /** The group's row dir (tournament.ts rowDir). */
  dir: string;
  repo: string;
  args: string[];
}

const notBuilt = (verb: string): never => {
  throw new Error(`tournament ${verb} not built (B3c tournament_gate)`);
};

/** §4.4 R3: which scenarios exercise each finalist (text, behaviour, live haiku runs). Exit code. */
export async function runScan(_o: GateOpts): Promise<number> {
  return notBuilt("r3");
}

/** §4.5 R4: finalists plus base on the exercising scenarios; the decision. Exit code (7: review stop). */
export async function runR4Gate(_o: GateOpts): Promise<number> {
  return notBuilt("r4");
}

/** §4.6 the final gate: holdouts once on the combined winners surface, logs under sealed/. Exit code. */
export async function runFinal(_o: GateOpts): Promise<number> {
  return notBuilt("final");
}
