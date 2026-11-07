// The tournament report (spec docs/specs/2026-11-07-hill-r2-tournament.md §6). B3b ships the
// signature the CLI calls; B3c (`tournament_gate`) replaces the body.
import type { GateOpts } from "./tournament-r4.ts";

/** `tournament report <group> --out <md>`: the §6 sections, and the copy of tournament.jsonl. Exit code. */
export async function writeReport(_o: GateOpts & { out: string }): Promise<number> {
  throw new Error("tournament report not built (B3c tournament_gate)");
}
