// mu — shared helpers for concrete VCS backends.

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { CommitSummary } from "./types.js";

export const exec = promisify(execFile);

/** True iff `cmd args` run in `cwd` exits 0 with output (git not installed,
 *  or cwd outside a repo, both read as "no"). */
export async function probeVcsRoot(cmd: string, args: string[], cwd: string): Promise<boolean> {
  try {
    return (await run(cmd, args, cwd)).trim().length > 0;
  } catch {
    return false;
  }
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export function rmDirSync(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

/**
 * Run a binary with args. Throws a typed Error on non-zero exit. Stdout
 * is returned trimmed; stderr is appended to the Error message.
 */
export async function run(bin: string, args: readonly string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await exec(bin, [...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`vcs ${bin} ${args.join(" ")} failed: ${msg}`, { cause: err });
  }
}

function relTimeFromIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return `${Math.floor(day / 7)}w`;
}

export function commitSummary(
  sha: string,
  subject: string,
  body: string,
  authorDate: string,
  author = "",
): CommitSummary {
  return { sha, subject, body, author, authorDate, relTime: relTimeFromIso(authorDate) };
}
