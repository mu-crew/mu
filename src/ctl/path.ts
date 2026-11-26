/**
 * Per-agent control socket path. Derived from (state dir, workstream,
 * agent) on every call; never stored. The mu pi extension serves the
 * socket at `$MU_CTL_SOCK`, and mu connects to the same derived path. A
 * session template's forward binds a fresh path the derived one links to
 * (linkForwardSocket).
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type Db, defaultStateDir } from "../db.js";

/** Env var spawn injects so the pi extension knows where to listen. */
export const CTL_SOCK_ENV = "MU_CTL_SOCK";

/** macOS sun_path is 104 bytes including the trailing NUL. */
export const MAX_SOCK_PATH = 103;

/** Directory of hashed paths: not a valid workstream name. */
const HASHED_DIR = "_h";

/**
 * `<dir>/<ws>/<agent>.sock`, or `<dir>/_h/<hash>.sock` past MAX_SOCK_PATH. `_h` starts with
 * `_`, which no workstream name can (`^[a-z]...`), so a hashed path never aliases a readable
 * one: with `h/` a workstream `h` plus an agent named like a hash collided.
 */
function sockPathUnder(dir: string, workstream: string, agent: string, ext = "sock"): string {
  const readable = join(dir, workstream, `${agent}.${ext}`);
  if (Buffer.byteLength(readable) <= MAX_SOCK_PATH) return readable;
  const h = createHash("sha1").update(`${workstream}/${agent}`).digest("hex").slice(0, 16);
  return join(dir, HASHED_DIR, `${h}.${ext}`);
}

/**
 * Always absolute, shortened on the absolute spelling: a relative MU_DB_PATH or SDK `openDb`
 * path whose relative socket name fits can overflow sun_path once resolved, and the socket
 * is bound, forwarded and unlinked from other working directories (the wire's `sockets.local`).
 */
export function ctlSocketPath(workstream: string, agent: string, stateDir?: string): string {
  const dbPath = process.env.MU_DB_PATH;
  const base = stateDir ?? (dbPath ? dirname(dbPath) : defaultStateDir());
  const state = resolve(base);
  const local = sockPathUnder(join(state, "sock"), workstream, agent);
  if (Buffer.byteLength(local) <= MAX_SOCK_PATH) return local;
  const hash = createHash("sha256")
    .update(JSON.stringify([state, workstream, agent]))
    .digest("hex");
  return join(shortSockRoot(), `${hash}.sock`);
}

/** The same short root across invocations, even with a long or different TMPDIR. */
function shortSockRoot(): string {
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error("Unix control sockets require a user ID");
  const dir = `/tmp/mu-s-${uid}`;
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o777) !== 0o700) {
    throw new Error(
      `Unsafe control socket directory ${dir}: expected a directory owned by uid ${uid} with mode 0700`,
    );
  }
  return dir;
}

/**
 * Remove the ctl socket at `sock`. When it is a link, the target goes too only if it is
 * provably the forward path linkForwardSocket generated for this name (`<name>.<nonce>.sock`
 * beside it, or `f-<hash of sock>-<nonce>.sock` under the short root) and a socket: the link
 * is never followed to anything else (a user's file, another agent's forward). Then the name.
 */
export function removeCtlSocket(sock: string): void {
  let target: string | undefined;
  try {
    if (lstatSync(sock).isSymbolicLink()) target = resolve(dirname(sock), readlinkSync(sock));
  } catch {
    return; // nothing there
  }
  if (target !== undefined && isForwardOf(sock, target)) {
    try {
      if (lstatSync(target).isSocket()) rmSync(target, { force: true });
    } catch {
      /* already gone */
    }
  }
  rmSync(sock, { force: true });
}

const NONCE_HEX = 12; // randomBytes(6)

/** `target` has one of the two shapes linkForwardSocket gives `sock`'s forward path. */
function isForwardOf(sock: string, target: string): boolean {
  const uid = process.geteuid?.();
  const prefixes = [
    `${join(dirname(sock), basename(sock, ".sock"))}.`,
    ...(uid === undefined ? [] : [join(`/tmp/mu-s-${uid}`, `f-${forwardHash(sock)}-`)]),
  ];
  return prefixes.some((p) => {
    if (!target.startsWith(p) || !target.endsWith(".sock")) return false;
    return new RegExp(`^[0-9a-f]{${NONCE_HEX}}$`).test(target.slice(p.length, -".sock".length));
  });
}

const forwardHash = (sock: string): string =>
  createHash("sha256").update(sock).digest("hex").slice(0, 16);

/**
 * A fresh local path for a session template's `-L` forward, linked from `sock` (the derived
 * path every reader connects to; connect follows the link). Over a shared ssh master the
 * master, not the pane's client, binds a `-L` and keeps it after the pane dies, and it answers
 * a second request for the same forward without binding it again: a respawn of the name on
 * the derived path got no socket (`ctl: missing`). A new path per spawn is a new forward. The
 * master's old ones stay until it exits, bound to paths mu has removed. Removes whatever
 * `sock` held first; the caller owns the name.
 */
export function linkForwardSocket(sock: string): string {
  removeCtlSocket(sock);
  const nonce = randomBytes(NONCE_HEX / 2).toString("hex");
  const beside = join(dirname(sock), `${basename(sock, ".sock")}.${nonce}.sock`);
  const forward =
    Buffer.byteLength(beside) <= MAX_SOCK_PATH
      ? beside
      : join(shortSockRoot(), `f-${forwardHash(sock)}-${nonce}.sock`);
  symlinkSync(forward, sock);
  return forward;
}

/**
 * The file a lease carrier writes its job handle to: `<state dir>/carrier/<ws>/<agent>.job`,
 * hashed past the same bound as a ctl socket (`carrier/_h/<hash>.job`). Derived, never stored.
 * Always absolute (the wire's `jobFile`, placement spec §10): a relative MU_DB_PATH or SDK
 * `openDb` path leaves the state dir relative, and spawn, reattach and recovery derive one path.
 * The hash is decided on the spelling given, then resolved: a file has no sun_path bound, and a
 * template lease published before the wire went absolute keeps its name (deciding on the
 * absolute spelling moved a readable name to `_h/`, and close could no longer find its handle).
 */
export function carrierJobFilePath(workstream: string, agent: string, stateDir?: string): string {
  const dbPath = process.env.MU_DB_PATH;
  const base = stateDir ?? (dbPath ? dirname(dbPath) : defaultStateDir());
  return resolve(sockPathUnder(join(base, "carrier"), workstream, agent, "job"));
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
    removeCtlSocket(ctlSocketPath(workstream, name, dirname(db.name)));
  } catch {
    /* best-effort */
  }
}

/**
 * Default socket path ON THE REMOTE HOST for a remote pi agent:
 * `/tmp/mu-<uid>/<ws>/<agent>.sock`, shortened by the same rule. `uid`
 * is the local one (mu cannot know the remote's); the extension creates
 * the directory.
 */
export function remoteCtlSocketPath(workstream: string, agent: string, uid: number): string {
  return sockPathUnder(`/tmp/mu-${uid}`, workstream, agent);
}
