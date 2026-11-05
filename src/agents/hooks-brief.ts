// mu — the brief file of a `hooks` task spawn (spec D17).
//
// A hook harness worker is launched with no prompt. Its task brief goes into
// a file in its cwd, `.mu/brief-<agent>-<attempt key>.md`, so two workers in
// one cwd never share one, and only a one-line pointer to it is pasted: the
// shortest text a dialog that opens as the paste lands can swallow. The file
// holds exactly the bytes the receipt's request hash covers, so a replay of
// the attempt rewrites the same file. `.mu/.gitignore` (`*`) keeps the
// directory out of `git status` and `git add -A`; nothing in the repo's own
// config changes.
//
// A remote worker's file is written on its host by one exec of the profile's
// `exec` template, the brief inside the command as one argument: exec
// templates have no stdin path, and Linux caps one argument at 128 KiB
// (MAX_ARG_STRLEN). The brief rides as printf's `%b` operand with its `\` and
// `'` as escapes, so the two or three shell-quoting layers around it never
// grow it; a brief over 96 KB so escaped is refused (RemoteBriefTooLargeError),
// and so is a command that still comes to 128 KiB (a long cwd or template).

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.js";
import {
  expandHostTemplate,
  HOST_COMMAND_TIMEOUT_MS,
  type HostTemplateValues,
  runLeasedTemplate,
  withHostChannel,
} from "../hosts.js";
import { localPaneAlive, RemotePrepareError } from "../remote-agent.js";
import { shellQuote } from "../shell-quote.js";
import { RemoteBriefTooLargeError } from "./errors.js";

/** The directory, in the worker's cwd, that holds its brief files. */
export const BRIEF_DIR = ".mu";

/** `brief-<agent>-<attempt key>.md`, the key's `:` and any other unsafe character as `-`. */
export function briefFileName(agent: string, attemptKey: string): string {
  return `brief-${agent}-${attemptKey.replace(/[^A-Za-z0-9._-]/g, "-")}.md`;
}

/**
 * Write the brief into `<cwd>/.mu/` (replaced by rename, so the worker never
 * reads half of it) and `.mu/.gitignore` beside it. Returns the file's path.
 * Throws on a filesystem error: nothing was pasted yet.
 */
export function writeBriefFile(
  cwd: string,
  agent: string,
  attemptKey: string,
  text: string,
): string {
  const dir = join(cwd, BRIEF_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "*\n");
  const path = join(dir, briefFileName(agent, attemptKey));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return path;
}

/** The one line pasted into the worker: read the brief file and follow it. */
export function briefPointer(path: string): string {
  return `Read your task brief in ${path} and follow it.`;
}

/** The largest brief a remote brief file takes, in bytes once escaped (spec D17). */
export const REMOTE_BRIEF_MAX_BYTES = 96 * 1024;

/** Linux's cap on one exec argument (MAX_ARG_STRLEN), its terminating NUL included. */
export const EXEC_ARG_MAX_BYTES = 128 * 1024;

/**
 * The brief as printf's `%b` operand: each `\` doubled and each `'` as
 * `\0047`, so the operand holds no `'` and a shell-quoting layer adds only
 * its two quotes around it, however many layers there are.
 */
export function briefPrintfOperand(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\0047");
}

/** Throw RemoteBriefTooLargeError unless `text`, escaped, fits a remote brief file on `host`. */
export function assertRemoteBriefFits(agent: string, host: string, text: string): void {
  const escaped = Buffer.byteLength(briefPrintfOperand(text));
  if (escaped > REMOTE_BRIEF_MAX_BYTES) {
    throw new RemoteBriefTooLargeError(
      agent,
      host,
      Buffer.byteLength(text),
      REMOTE_BRIEF_MAX_BYTES,
      escaped,
    );
  }
}

/** The line the remote script prints with the file's path (a login shell may print noise first). */
const BRIEF_MARK = "MU_BRIEF";

/**
 * The remote script (the exec template's `{cmd}`): make `<cwd>/.mu`, write
 * `.gitignore` (`*`) and the brief beside it (replaced by rename), print the
 * path. The brief is one single-quoted word with no `'` inside
 * ({@link briefPrintfOperand}), printed byte for byte by `%b`.
 */
export function remoteBriefScript(
  cwd: string,
  agent: string,
  attemptKey: string,
  text: string,
): string {
  const body = [
    `d=${shellQuote(cwd)}/${BRIEF_DIR}`,
    `mkdir -p "$d" || exit 5`,
    `printf '*\\n' > "$d/.gitignore" || exit 5`,
    `f="$d"/${shellQuote(briefFileName(agent, attemptKey))}`,
    `t="$f.$$.tmp"`,
    `printf '%b' ${shellQuote(briefPrintfOperand(text))} > "$t" && mv -f "$t" "$f" || { rm -f "$t"; exit 5; }`,
    `printf '${BRIEF_MARK} %s\\n' "$f"`,
  ].join("\n");
  return `sh -c ${shellQuote(body)}`;
}

/**
 * Write a remote worker's brief file on `host` in its (remote, absolute)
 * `cwd`, through one exec under a transient channel. Returns the file's path
 * as the host printed it. Throws before anything is pasted: a brief over the
 * cap, a refused channel, a filled template of 128 KiB or more (nothing run),
 * or an exec that failed or answered no path.
 */
export async function writeRemoteBriefFile(
  db: Db,
  host: string,
  cwd: string,
  agent: string,
  workstream: string,
  attemptKey: string,
  text: string,
): Promise<string> {
  assertRemoteBriefFits(agent, host, text);
  const what = "writing the task brief file failed";
  const values: HostTemplateValues = { cmd: remoteBriefScript(cwd, agent, attemptKey, text), cwd };
  const r = await withHostChannel(
    db,
    host,
    `brief:${workstream}/${agent}`,
    (profile, lease) => {
      // The filled template is ONE argument of the local `/bin/sh -c`, and holds every
      // argument the host's shells get: measured as exec'd, before anything runs.
      const command = Buffer.byteLength(expandHostTemplate(profile.exec, values, "exec"));
      if (command >= EXEC_ARG_MAX_BYTES) {
        const bytes = Buffer.byteLength(text);
        const escaped = Buffer.byteLength(briefPrintfOperand(text));
        throw new RemoteBriefTooLargeError(
          agent,
          host,
          bytes,
          EXEC_ARG_MAX_BYTES,
          escaped,
          command,
        );
      }
      return runLeasedTemplate(db, lease, profile, "exec", values, HOST_COMMAND_TIMEOUT_MS);
    },
    { paneAlive: localPaneAlive },
  );
  if (r.exitCode === null) {
    throw new RemotePrepareError(host, what, `timed out after ${HOST_COMMAND_TIMEOUT_MS}ms`);
  }
  if (r.exitCode !== 0) {
    const why = (r.stderr.trim() || r.stdout.trim()).split("\n")[0] ?? "";
    throw new RemotePrepareError(host, what, `exit ${r.exitCode}${why === "" ? "" : `: ${why}`}`);
  }
  for (const l of r.stdout.split("\n").reverse()) {
    const m = new RegExp(`^${BRIEF_MARK} (/.+)$`).exec(l.trim());
    if (m?.[1] !== undefined) return m[1];
  }
  throw new RemotePrepareError(host, what, "the host's answer named no path");
}
