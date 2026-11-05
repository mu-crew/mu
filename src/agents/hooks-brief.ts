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

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
