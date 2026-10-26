// Vitest guard: a test must never write under the user's real mu dirs.
//
// test/_setup.ts redirects XDG_CACHE_HOME / XDG_STATE_HOME / XDG_CONFIG_HOME
// to a per-fork temp dir, so mu's own resolvers (src/state-dir.ts) land
// there. This guard is the second layer, like the real-DB guard in
// src/db.ts: a test that hard-codes `~/.cache/mu` or sets MU_STATE_DIR to
// a real path gets a thrown error naming the call site, not a silent
// write into the developer's live state.
//
// It wraps node:fs mutators (sync, callback and promise forms) in this
// process. Child processes (the mu CLI under test) are covered by the env
// redirect, which they inherit; SQLite writes by the openDb guard.

import fs, { type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const INSTALLED = Symbol.for("mu.test.realDirGuard");

/** The user's real mu dirs, computed from the env as it was inherited. */
export function realMuDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? homedir();
  const abs = (v: string | undefined, fallback: string) =>
    v !== undefined && isAbsolute(v) ? v : fallback;
  const cache = abs(env.XDG_CACHE_HOME, join(home, ".cache"));
  const state = abs(env.XDG_STATE_HOME, join(home, ".local", "state"));
  const config = abs(env.XDG_CONFIG_HOME, join(home, ".config"));
  return [
    ...new Set([
      join(cache, "mu"),
      join(state, "mu"),
      join(state, "mu-next"),
      join(config, "mu"),
      join(home, ".cache", "mu"),
      join(home, ".local", "state", "mu"),
      join(home, ".local", "state", "mu-next"),
    ]),
  ].map((p) => resolve(p));
}

function underAny(p: string, roots: readonly string[]): string | undefined {
  const abs = resolve(p);
  return roots.find((r) => abs === r || abs.startsWith(`${r}/`));
}

function pathOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL) return arg.protocol === "file:" ? arg.pathname : undefined;
  if (Buffer.isBuffer(arg)) return arg.toString();
  return undefined;
}

type Fn = (...args: unknown[]) => unknown;

/** Which argument indexes of each mutator are paths it changes. */
const MUTATORS: Record<string, number[]> = {
  writeFile: [0],
  appendFile: [0],
  mkdir: [0],
  mkdtemp: [0],
  rename: [0, 1],
  copyFile: [1],
  cp: [1],
  rm: [0],
  rmdir: [0],
  unlink: [0],
  truncate: [0],
  symlink: [1],
  link: [1],
  createWriteStream: [0],
  open: [0], // read-only opens are allowed: see isWriteFlag
};

function isWriteFlag(flags: unknown): boolean {
  if (typeof flags === "number") return (flags & 3) !== 0; // O_WRONLY | O_RDWR
  return typeof flags === "string" && /[wa+]/.test(flags);
}

export function installRealDirGuard(roots: readonly string[]): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;

  const check = (name: string, args: unknown[], idx: number[]): void => {
    if (name === "open" && !isWriteFlag(args[1])) return;
    for (const i of idx) {
      const p = pathOf(args[i]);
      const root = p === undefined ? undefined : underAny(p, roots);
      if (root !== undefined) {
        throw new Error(
          `fs.${name} refused: tests must NEVER write to the user's real mu dir (${root}): ${p}. test/_setup.ts redirects XDG_CACHE_HOME / XDG_STATE_HOME / XDG_CONFIG_HOME to a temp dir; use defaultCacheDir() / defaultStateDir() or a mkdtemp path instead of a hard-coded home path.`,
        );
      }
    }
  };

  const target = fs as unknown as Record<string, Fn>;
  const promises = fs.promises as unknown as Record<string, Fn>;
  for (const [name, idx] of Object.entries(MUTATORS)) {
    for (const [owner, key] of [
      [target, name],
      [target, `${name}Sync`],
      [promises, name],
    ] as const) {
      const orig = owner[key];
      if (typeof orig !== "function") continue;
      owner[key] = function guarded(this: unknown, ...args: unknown[]) {
        try {
          check(name, args, idx);
        } catch (e) {
          // The promise API rejects; it never throws synchronously.
          if (owner === promises) return Promise.reject(e);
          throw e;
        }
        return orig.apply(this, args);
      };
    }
  }
  syncBuiltinESMExports();
}

export type { PathLike };
