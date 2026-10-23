// mu — git VCS backend.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { commitSummary, ensureParent, exec, probeVcsRoot, rmDirSync, run } from "./helpers.js";
import type { CommitSummary, FreeWorkspaceResult, VcsBackend } from "./types.js";

// Uses `git worktree` so the new workspace shares the .git store with
// the project root. Cheap (no copy), fast, and integrates with the rest
// of the agent's git workflow (push, log, etc) trivially.

export const gitBackend: VcsBackend = {
  name: "git",

  async detect(projectRoot) {
    return probeVcsRoot("git", ["rev-parse", "--show-toplevel"], projectRoot);
  },

  async createWorkspace(opts) {
    if (existsSync(opts.workspacePath)) {
      throw new Error(`vcs git: workspacePath already exists: ${opts.workspacePath}`);
    }
    await ensureParent(opts.workspacePath);
    // Defensive prune: if a previous workspace at the same path was
    // freed by `rm -rf` (or otherwise lost its dir without proper
    // teardown), git's worktree registry still points at it. Then
    // `git worktree add` fails with 'missing but already registered
    // worktree'. `git worktree prune` is idempotent and cheap; running
    // it BEFORE every add costs ~10ms and immunises us against the
    // mufeedback workspace_free_cleanup_leaves_git case.
    await run("git", ["worktree", "prune"], opts.projectRoot).catch(() => {
      /* prune is best-effort; if it fails we'll get a clear error from `add` next */
    });
    // `git worktree add <path> [<ref>]`. Without a ref, the new worktree
    // checks out a detached HEAD at the project's current HEAD, which
    // matches the "fresh per-agent workspace" semantics we want. Use a
    // detached HEAD by default so two agents from the same parent ref
    // don't collide on a branch name.
    const args = ["worktree", "add", "--detach", opts.workspacePath];
    if (opts.parentRef) args.push(opts.parentRef);
    await run("git", args, opts.projectRoot);
    // Resolve the actual SHA we ended up on for the parentRef record.
    const sha = await run("git", ["rev-parse", "HEAD"], opts.workspacePath);
    return { parentRef: sha };
  },

  // Working-copy clean check: empty `git status --porcelain` output
  // means no working-tree, staged, or untracked-not-ignored changes.
  // Returns false on any failure (workspace path missing, git
  // explodes) — be conservative; auto-free should never "silently
  // succeed" because we couldn't check.
  async isClean(workspacePath) {
    if (!existsSync(workspacePath)) return false;
    try {
      const files = await listGitDirtyFiles(workspacePath);
      return files.length === 0;
    } catch {
      return false;
    }
  },

  // List commits in (baseRef..HEAD), oldest-first. The format string
  // packs four NUL-delimited fields per record, then a record
  // separator '\x1e' (RECORD-SEPARATOR control char) so subjects /
  // bodies with embedded newlines or NULs survive parsing. We don't
  // use a JSON template because git's `--format` is field-oriented;
  // %x00 (NUL) and %x1e (RS) are git's portable escape sequences.
  async commitsSinceBase(workspacePath, baseRef) {
    if (!existsSync(workspacePath)) {
      throw new Error(`vcs git: workspace path missing: ${workspacePath}`);
    }
    const out = await run(
      "git",
      [
        "log",
        "--reverse",
        "-z",
        "--format=%H%x00%s%x00%b%x00%aI",
        `${await forkPoint(workspacePath, baseRef)}..HEAD`,
      ],
      workspacePath,
    );
    if (out.length === 0) return [];
    // -z makes git use NUL as the record separator; combined with our
    // %x00 field separators each commit looks like:
    //   <sha>\0<subject>\0<body>\0<authorDate>\0
    // i.e. four fields followed by the record-terminating NUL git
    // injects with -z. Splitting on NUL leaves us with 4N fields plus
    // a trailing empty string we drop.
    const fields = out.split("\x00");
    const records: CommitSummary[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const sha = fields[i] ?? "";
      const subject = fields[i + 1] ?? "";
      const body = fields[i + 2] ?? "";
      const authorDate = fields[i + 3] ?? "";
      if (sha.length === 0) continue;
      records.push(commitSummary(sha, subject, body, authorDate));
    }
    return records;
  },

  async freeWorkspace(opts) {
    // Disk-missing case: a previous caller (or the user) ran `rm -rf`
    // out from under us, but the git worktree registry STILL has an
    // entry pointing here. Without a prune, the next `git worktree
    // add` at this path errors out (the mufeedback case). We can't
    // reach the project root via the workspace itself (the .git
    // pointer file is gone with the dir), and we can't reliably guess
    // WHICH project root, so we return { removed: false } without
    // pruning; createWorkspace's defensive prune (above) reaps the
    // dead registry entry on next use.
    if (!existsSync(opts.workspacePath)) {
      return { removed: false };
    }
    let committedRef: string | undefined;
    let branch: string | undefined;
    if (opts.commit) {
      // Commit only if there's anything to commit. Reuse the same
      // dirty-file semantics as isClean(): `git status
      // --porcelain` includes working-tree, staged, and untracked-not-
      // ignored changes.
      const dirty = (await listGitDirtyFiles(opts.workspacePath)).length > 0;
      if (dirty) {
        await run("git", ["add", "-A"], opts.workspacePath);
        await run(
          "git",
          [
            "-c",
            "user.email=mu@local",
            "-c",
            "user.name=mu",
            "commit",
            "-m",
            "mu workspace free auto-commit",
          ],
          opts.workspacePath,
        );
        committedRef = await run("git", ["rev-parse", "HEAD"], opts.workspacePath);
      }
      // The worktree's HEAD is detached (createWorkspace uses --detach),
      // so removing the worktree would leave the auto-commit, and any
      // commit the agent made, reachable from no ref: git gc deletes
      // them. Pin HEAD with a branch unless a branch, remote or tag
      // already contains it.
      branch = await keepGitHeadReachable(opts.workspacePath);
    }
    // Tear down: git worktree remove --force <path> cleans both the
    // on-disk directory AND the git/worktrees/<name>/ admin entry. We
    // can't easily run it from the project root (we don't store it on
    // the workspace row), but git accepts the worktree's own path from
    // anywhere with --force, so we resolve a usable cwd via git's own
    // pointer back to the project's .git dir.
    const projectRoot = await resolveGitProjectRoot(opts.workspacePath);
    if (projectRoot) {
      await run("git", ["worktree", "remove", "--force", opts.workspacePath], projectRoot);
    } else {
      // Lost the link — just rm the directory. git's admin entry will
      // be cleaned by the next `git worktree prune` invocation.
      rmDirSync(opts.workspacePath);
    }
    const result: FreeWorkspaceResult = { removed: true };
    if (committedRef !== undefined) result.committedRef = committedRef;
    if (branch !== undefined) result.branch = branch;
    return result;
  },

  async listDirtyFiles(workspacePath) {
    if (!existsSync(workspacePath)) return [];
    return listGitDirtyFiles(workspacePath);
  },
};

/**
 * The workspace's current fork point. `parent_ref` is recorded once at
 * spawn; a manual `git rebase` onto an advanced main leaves it at the
 * old fork, so `<parent_ref>..HEAD` would list main-only commits. Every
 * reader therefore derives the fork point: merge-base(HEAD, the project
 * root's HEAD) when that is newer than `parentRef` (parentRef is its
 * ancestor), else `parentRef` itself. Falls back to `parentRef` on any
 * git failure (never a wider range than the recorded one).
 */
export async function forkPoint(workspacePath: string, parentRef: string): Promise<string> {
  try {
    const root = await resolveGitProjectRoot(workspacePath);
    if (root === undefined) return parentRef;
    const mainHead = await run("git", ["rev-parse", "HEAD"], root);
    const mb = await run("git", ["merge-base", "HEAD", mainHead], workspacePath);
    if (mb.length === 0 || mb === parentRef) return parentRef;
    await run("git", ["merge-base", "--is-ancestor", parentRef, mb], workspacePath);
    return mb;
  } catch {
    return parentRef;
  }
}

/**
 * Return the list of dirty paths (working-tree modifications + staged
 * + untracked-not-ignored), one entry per file. Empty when clean.
 * Used by isClean, listDirtyFiles and the commit-before-free check.
 */
async function listGitDirtyFiles(workspacePath: string): Promise<string[]> {
  // `git status --porcelain` prints one line per changed file with
  // a 2-char status prefix; trim the prefix to get the path. Untracked
  // files appear as `?? path` and are included by default.
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: workspacePath });
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  return lines.map((l) => l.slice(3));
}

/**
 * Create a branch at the worktree's HEAD when no branch, remote-tracking
 * ref or tag contains it, so the commits survive `git worktree remove`.
 * The name is `mu/<workstream>/<agent>-<sha12>`, taken from the
 * workspace path (`<state>/workspaces/<workstream>/<agent>`); the sha
 * suffix keeps a re-spawned agent's later free from colliding. Returns
 * the branch name, or undefined when HEAD was already reachable.
 */
async function keepGitHeadReachable(workspacePath: string): Promise<string | undefined> {
  const containing = await run(
    "git",
    ["for-each-ref", "--count=1", "--contains", "HEAD", "refs/heads", "refs/remotes", "refs/tags"],
    workspacePath,
  );
  if (containing.length > 0) return undefined;
  const sha = await run("git", ["rev-parse", "HEAD"], workspacePath);
  const parts = workspacePath.replace(/\/+$/, "").split("/");
  const agent = parts.at(-1) ?? "workspace";
  const workstream = parts.at(-2) ?? "mu";
  const branch = `mu/${workstream}/${agent}-${sha.slice(0, 12)}`;
  await run("git", ["branch", branch, sha], workspacePath);
  return branch;
}

/**
 * Resolve the project root that owns this worktree. Returns undefined
 * if the link is broken (e.g. project root deleted). git rev-parse
 * --git-common-dir gives us the parent project's .git dir; the worktree's
 * project root is its parent.
 */
async function resolveGitProjectRoot(workspacePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: workspacePath },
    );
    return resolve(stdout.trim(), "..");
  } catch {
    return undefined;
  }
}
