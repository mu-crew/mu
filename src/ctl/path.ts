/**
 * Per-agent control socket path. Derived from (state dir, workstream,
 * agent) on every call; never stored. The mu pi extension serves the
 * socket at `$MU_CTL_SOCK`, and mu connects to the same derived path.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { defaultStateDir } from "../db.js";

/** Env var spawn injects so the pi extension knows where to listen. */
export const CTL_SOCK_ENV = "MU_CTL_SOCK";

/** macOS sun_path is 104 bytes including the trailing NUL. */
export const MAX_SOCK_PATH = 103;

export function ctlSocketPath(workstream: string, agent: string, stateDir?: string): string {
  const dbPath = process.env.MU_DB_PATH;
  const base = stateDir ?? (dbPath ? dirname(dbPath) : defaultStateDir());
  const readable = join(base, "sock", workstream, `${agent}.sock`);
  if (Buffer.byteLength(readable) <= MAX_SOCK_PATH) return readable;
  const h = createHash("sha1").update(`${workstream}/${agent}`).digest("hex").slice(0, 16);
  return join(base, "sock", "h", `${h}.sock`);
}
