// The dev-build migration guard: a mu that is not the installed package
// (its code runs from a git checkout or worktree, or MU_DEV_BUILD=1) must
// not upgrade the schema or capture stamp of the user's default DB. Branch
// builds run by reviewers migrated the live DB twice on 2026-11-27; a brief
// asking for MU_STATE_DIR could not prevent it (mu pins MU_DB_PATH to the
// live DB in every pane, and it wins over MU_STATE_DIR). The guard therefore
// keys on the RESOLVED DB path. It also keeps such a build from publishing
// the live DB's ops to MU_SYNC_DIR (flushSegment). openDb calls
// refuseDevBuildMigration only when the DB needs an upgrade, so reads of an
// up-to-date DB still work. MU_ALLOW_MIGRATE=1 opts out.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDirIn, xdgStateHome } from "./state-dir.js";

/** Thrown by openDb when a development build would migrate the default
 *  DB. Nothing was written. Exit 4. */
export class DevBuildMigrationError extends Error {
  override readonly name = "DevBuildMigrationError";
  constructor(
    public readonly buildPath: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(
      `this mu is a development build (${buildPath}); it would migrate your live DB from ${from} to ${to}. Unset MU_DB_PATH and set MU_STATE_DIR to a scratch dir, or MU_ALLOW_MIGRATE=1.`,
    );
  }
}

/** The checkout `file` runs from: the nearest ancestor holding `.git` (a
 *  dir in a clone, a file in a worktree). Null when an ancestor is
 *  `node_modules` first (an installed package) or none holds `.git`. */
export function devBuildRoot(file: string): string | null {
  let dir = dirname(resolve(file));
  for (;;) {
    if (basename(dir) === "node_modules") return null;
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let seam: { moduleFile?: string; defaultDb?: string } = {};

/** Tests point the guard at a fake build location and default DB (the
 *  real default DB is off limits under vitest). `{}` restores. */
export function setDevBuildGuardForTests(next: { moduleFile?: string; defaultDb?: string }): void {
  seam = next;
}

/** The user's live DB: the default state dir's mu.db, from HOME and
 *  XDG_STATE_HOME only. MU_STATE_DIR and MU_DB_PATH are not consulted: mu
 *  pins MU_DB_PATH to this file in every pane it spawns, so a reviewer's
 *  MU_STATE_DIR alone never moved off it (the 2026-11-27 incidents). */
function liveDbPath(): string {
  return seam.defaultDb ?? join(stateDirIn(xdgStateHome(homedir())), "mu.db");
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** This build's checkout when it is a development build and `dbPath`
 *  resolves to the user's live DB; else null. MU_ALLOW_MIGRATE=1 always
 *  answers null. */
export function devBuildOnLiveDb(dbPath: string): string | null {
  if (process.env.MU_ALLOW_MIGRATE === "1") return null;
  if (canonical(dbPath) !== canonical(liveDbPath())) return null;
  const moduleFile = seam.moduleFile ?? fileURLToPath(import.meta.url);
  return process.env.MU_DEV_BUILD === "1" ? dirname(moduleFile) : devBuildRoot(moduleFile);
}

/** Throw DevBuildMigrationError when a development build would upgrade
 *  the live DB at `path`, however it was reached (defaults, MU_DB_PATH,
 *  MU_STATE_DIR). */
export function refuseDevBuildMigration(path: string, from: string, to: string): void {
  const build = devBuildOnLiveDb(path);
  if (build !== null) throw new DevBuildMigrationError(build, from, to);
}

/** Thrown by a sync flush when a development build would publish the live
 *  DB's ops to MU_SYNC_DIR. The ops stay pending in `ops`; the installed mu
 *  publishes them. Exit 4 from `mu sync`; the ambient flush only warns. */
export class DevBuildSyncError extends Error {
  override readonly name = "DevBuildSyncError";
  constructor(
    public readonly buildPath: string,
    public readonly syncDir: string,
  ) {
    super(
      `this mu is a development build (${buildPath}); it does not publish your live DB's ops to ${syncDir} (the installed mu will). Unset MU_DB_PATH and MU_SYNC_DIR and set MU_STATE_DIR to a scratch dir, or MU_ALLOW_MIGRATE=1.`,
    );
  }
}

/** Throw DevBuildSyncError when a development build would flush the live
 *  DB at `dbPath` into `syncDir`. */
export function refuseDevBuildSync(dbPath: string, syncDir: string): void {
  const build = devBuildOnLiveDb(dbPath);
  if (build !== null) throw new DevBuildSyncError(build, syncDir);
}
