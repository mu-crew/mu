/**
 * Per-agent control socket path. Derived from (state dir, workstream,
 * agent) on every call; never stored. The mu pi extension serves the
 * socket at `$MU_CTL_SOCK`, and mu connects to the same derived path.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Db, defaultStateDir } from "../db.js";

/** Env var spawn injects so the pi extension knows where to listen. */
export const CTL_SOCK_ENV = "MU_CTL_SOCK";

/** macOS sun_path is 104 bytes including the trailing NUL. */
export const MAX_SOCK_PATH = 103;

/** `<dir>/<ws>/<agent>.sock`, or `<dir>/h/<hash>.sock` past MAX_SOCK_PATH. */
function sockPathUnder(dir: string, workstream: string, agent: string): string {
  const readable = join(dir, workstream, `${agent}.sock`);
  if (Buffer.byteLength(readable) <= MAX_SOCK_PATH) return readable;
  const h = createHash("sha1").update(`${workstream}/${agent}`).digest("hex").slice(0, 16);
  return join(dir, "h", `${h}.sock`);
}

export function ctlSocketPath(workstream: string, agent: string, stateDir?: string): string {
  const dbPath = process.env.MU_DB_PATH;
  const base = stateDir ?? (dbPath ? dirname(dbPath) : defaultStateDir());
  return sockPathUnder(join(base, "sock"), workstream, agent);
}

/**
 * Remove an agent's local control socket file. For a remote agent ssh's
 * `-L` forward leaves that file behind when the connection dies; it
 * probes as `refused`, never `ok`, but it is litter. A local pi removes
 * its own on quit. Best-effort: callers have already deleted the row.
 */
export function unlinkCtlSocket(db: Db, name: string, workstream: string): void {
  if (db.memory) return;
  try {
    rmSync(ctlSocketPath(workstream, name, dirname(db.name)), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Default socket path ON THE REMOTE HOST for a remote pi agent:
 * `/tmp/mu-<uid>/<ws>/<agent>.sock`, shortened by the same rule. `uid`
 * is the local one (mu cannot know the remote's); the extension creates
 * the directory, and `mu agent remote-env --remote-sock` overrides it.
 */
export function remoteCtlSocketPath(workstream: string, agent: string, uid: number): string {
  return sockPathUnder(`/tmp/mu-${uid}`, workstream, agent);
}
