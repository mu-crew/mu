// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// What no AUT (rig-guard.ts) and no designer (tournament-design.ts) may read, in one place: the
// private stores (every agent's transcripts, the museum, the crew's own mu state with its DB,
// worktrees and eval rows), and the canary every rig file carries.
//
// The canary is a fixed token on the first and last line (or element) of every file under
// tools/eval, test/eval, docs/eval and docs/specs (test/eval/rig-guard.test.ts checks each). Path
// parsing cannot be complete (`cd` chains, globs, symlinks, `git show HEAD:<path>`); whatever way a
// tool reached a rig file, its output carries the token, and rigReads marks the run invalid.
import { join, resolve } from "node:path";

/** The token, built so this file's code does not spell it (stageRig strips the comment lines). */
export const RIG_CANARY: string = ["RIG", "CANARY", "f8dc74a2239b"].join("-");

/** A text holds the canary: it came from a rig file. */
export const hasCanary = (text: string): boolean => text.includes(RIG_CANARY);

/** `src` without its canary lines: a rig module staged into a sandbox (stageRig). */
export const stripCanary = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !hasCanary(l))
    .join("\n");

export interface PrivateStore {
  rule: string;
  dir: string;
}

/**
 * The private stores under `home`, the inner ones first (a path's rule is its first match): the
 * crew's worktrees and eval rows, every harness's transcripts, the museum store and the museum
 * checkout `museumDir` (`EVAL_MUSEUM_DIR`; no default: tournament-design.ts museumCheckout finds an
 * unnamed one on disk), and the whole mu state dir (the real DB).
 */
export function privateStores(home: string, museumDir?: string): PrivateStore[] {
  const state = join(home, ".local", "state", "mu-next");
  return [
    { rule: "crew worktrees", dir: join(state, "worktrees") },
    { rule: "eval transcripts", dir: join(state, "eval-transcripts") },
    { rule: "pi sessions", dir: join(home, ".pi", "agent", "sessions") },
    { rule: "claude projects", dir: join(home, ".claude", "projects") },
    { rule: "codex sessions", dir: join(home, ".codex", "sessions") },
    { rule: "museum", dir: join(home, "museum") },
    ...(museumDir ? [{ rule: "museum", dir: resolve(museumDir) }] : []),
    { rule: "mu state", dir: state },
  ];
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
