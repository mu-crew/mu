// mu — git primitives for worktrees. Plain functions: git is the only VCS.
//
// A mu worktree is `git worktree add --detach` (a named branch would break
// name reuse); everything here shells out to git and never reads .git.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { execGroupCapture } from "../exec-file.js";

const exec = promisify(execFile);

/** Run git in `cwd`; stdout trimmed. Throws an Error carrying git's stderr. */
export async function git(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(" ")} failed: ${msg}`, { cause: err });
  }
}

/** `git rev-parse --show-toplevel` of `dir`, or undefined outside a work tree. */
export async function gitToplevel(dir: string): Promise<string | undefined> {
  try {
    const out = await git(["rev-parse", "--show-toplevel"], dir);
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** HEAD commit of `dir`. */
export function headSha(dir: string): Promise<string> {
  return git(["rev-parse", "HEAD"], dir);
}

/**
 * The checkout that owns a worktree: its common git dir's parent. Undefined
 * when the link is broken (the owning repo is gone).
 */
export async function owningRoot(worktreePath: string): Promise<string | undefined> {
  try {
    const common = await git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      worktreePath,
    );
    return resolve(common, "..");
  } catch {
    return undefined;
  }
}

/**
 * `git -C root worktree add --detach <path> [<from>]`; returns the commit
 * the worktree is at. A stale registration of `path` (dir removed by hand)
 * is pruned first, or git refuses with "missing but already registered".
 */
export async function addWorktree(
  root: string,
  path: string,
  from?: string,
  /** Abort kills git and everything it started (hooks, filters): its own process group. */
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  mkdirSync(dirname(path), { recursive: true });
  await git(["worktree", "prune"], root).catch(() => {});
  const args = ["worktree", "add", "--detach", path, ...(from !== undefined ? [from] : [])];
  const r = await execGroupCapture("git", args, { cwd: root, signal });
  signal?.throwIfAborted();
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return headSha(path);
}

/** Remove a worktree nothing ever ran in, half-made ones included: git locks
 *  those `initializing`, which only a double --force removes. */
export async function discardWorktree(root: string | undefined, path: string): Promise<void> {
  const owner = root ?? (await owningRoot(path));
  if (owner !== undefined)
    await git(["worktree", "remove", "--force", "--force", path], owner).catch(() => {});
  rmSync(path, { recursive: true, force: true });
  if (owner !== undefined) await git(["worktree", "prune"], owner).catch(() => {});
}

/** `git worktree remove` (never `--force` unless asked); falls back to rm when the owning repo is gone. */
export async function removeWorktreeDir(
  root: string | undefined,
  path: string,
  force: boolean,
): Promise<void> {
  if (!existsSync(path)) {
    if (root !== undefined) await git(["worktree", "prune"], root).catch(() => {});
    return;
  }
  const owner = root !== undefined && existsSync(root) ? root : await owningRoot(path);
  if (owner === undefined) {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  await git(["worktree", "remove", ...(force ? ["--force"] : []), path], owner);
}

/** Dirty paths in `dir` (modified, staged, untracked-not-ignored); empty = clean. Throws on failure. */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: dir });
  return stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3));
}

/**
 * Everything already upstream of the worker: `base` (recorded at spawn),
 * the root's HEAD, `origin/HEAD` when it resolves, and the root's
 * `@{upstream}` when set. The worker's own commits are
 * `git rev-list HEAD --not <these>`, so a manual rebase onto advanced
 * local main or a fetched remote does not count the base's commits as the
 * worker's. Unresolved refs are skipped; the result is deduped SHAs and
 * always starts with `base`.
 */
export async function upstreamRefs(root: string, base: string): Promise<string[]> {
  const refs = [base];
  for (const rev of ["HEAD", "origin/HEAD", "@{upstream}"]) {
    try {
      const sha = await git(["rev-parse", "--verify", "-q", `${rev}^{commit}`], root);
      if (sha.length > 0 && !refs.includes(sha)) refs.push(sha);
    } catch {
      /* unresolved (no remote, no upstream): nothing extra to exclude */
    }
  }
  return refs;
}

/** True iff `sha` is an ancestor of (or equal to) `root`'s HEAD. */
export async function isAncestor(root: string, sha: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", sha, "HEAD"], root);
    return true;
  } catch {
    return false;
  }
}

/** Commits of `dir`'s HEAD that are in none of `notRefs`, newest first. */
export async function ownCommits(dir: string, notRefs: readonly string[]): Promise<string[]> {
  const out = await git(["rev-list", "HEAD", "--not", ...notRefs], dir);
  return out.length === 0 ? [] : out.split("\n");
}

/** `git branch <name> <sha>` in `root`. */
export async function createBranch(root: string, name: string, sha: string): Promise<void> {
  await git(["branch", name, sha], root);
}
