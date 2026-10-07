// mu — jj VCS backend.

import { existsSync } from "node:fs";
import {
  ensureParent,
  parseNulRecords,
  probeVcsRoot,
  rmDirSync,
  run,
  runShow,
  saneLimit,
} from "./helpers.js";
import { type FreeWorkspaceResult, type VcsBackend, WorkspaceConflictError } from "./types.js";

// `jj workspace add --name <name> <path>` shares the .jj/repo store
// while giving each agent its own working copy. Workspaces are named
// per repo; we use `<workstream>/<agent>` (the last two segments of
// our on-disk layout) because agent names are unique only per
// workstream.
//
// Free is two-step: `jj workspace forget` (no name: the current
// workspace) from the workspace itself unregisters; then we rm the dir
// since jj leaves the files behind. A dir that is already gone cannot
// be forgotten from here (free has no project root), so createWorkspace
// forgets a same-named registration whose root is missing, as git's
// `worktree prune` does.
//
// --commit semantics for jj: jj's working copy is always automatically
// snapshotted, so "commit" is really "capture the current change_id
// as the result." Nothing is ever lost; jj keeps all operations in
// its op log indefinitely. We additionally call `jj describe` to set
// a description IF the current commit's description is empty so the
// captured ref is human-discoverable.

export const jjBackend: VcsBackend = {
  name: "jj",

  async detect(projectRoot) {
    return probeVcsRoot("jj", ["root"], projectRoot);
  },

  async createWorkspace(opts) {
    if (existsSync(opts.workspacePath)) {
      throw new Error(`vcs jj: workspacePath already exists: ${opts.workspacePath}`);
    }
    await ensureParent(opts.workspacePath);
    const name = jjWorkspaceName(opts.workspacePath);
    await forgetIfRootMissing(name, opts.projectRoot);
    const args = ["workspace", "add", "--name", name];
    if (opts.parentRef) args.push("--revision", opts.parentRef);
    args.push(opts.workspacePath);
    await run("jj", args, opts.projectRoot);
    const commitId = await jjCommitId(opts.workspacePath);
    return { parentRef: commitId };
  },

  async freeWorkspace(opts) {
    if (!existsSync(opts.workspacePath)) {
      return { removed: false };
    }
    let committedRef: string | undefined;
    if (opts.commit) {
      const desc = await run(
        "jj",
        [
          "log",
          "-r",
          "@",
          "--no-graph",
          "--no-pager",
          "--color",
          "never",
          "--template",
          "description",
        ],
        opts.workspacePath,
      );
      if (desc.trim().length === 0) {
        await run("jj", ["describe", "-m", "mu workspace free auto-commit"], opts.workspacePath);
      }
      committedRef = await jjCommitId(opts.workspacePath);
    }
    // Bare `jj workspace forget` forgets the workspace it runs in, so
    // free never depends on how the name was derived (older mu used
    // the agent name alone). jj prints a hint about the working copy
    // becoming orphaned; we resolve that immediately by rm-ing the dir.
    await run("jj", ["workspace", "forget"], opts.workspacePath);
    rmDirSync(opts.workspacePath);
    const result: FreeWorkspaceResult = { removed: true };
    if (committedRef !== undefined) result.committedRef = committedRef;
    return result;
  },

  // jj working-copy clean: @ has no diff from its parent.
  // `jj diff -r @ --summary` prints one line per changed file; empty
  // stdout = clean. jj's auto-snapshotting means there's no separate
  // "untracked" bucket — every working-tree change is already in @.
  async isClean(workspacePath) {
    if (!existsSync(workspacePath)) return false;
    try {
      const out = await run(
        "jj",
        ["diff", "-r", "@", "--summary", "--no-pager", "--color", "never"],
        workspacePath,
      );
      return out.length === 0;
    } catch {
      return false;
    }
  },

  // Compute commits-behind via jj's `trunk()` revset, which resolves
  // to the project's configured trunk (default-branch heuristic).
  // Returns null when trunk() is unresolvable (e.g. fresh repo with
  // no configured trunk) or when the log call fails.
  //
  // Pure observation: NO `jj git fetch`, and `--ignore-working-copy`
  // so the probe neither snapshots the working copy (a full tree stat
  // per workspace on every `mu state` / TUI slow tick) nor writes a jj
  // operation. `<ref>..trunk()` never involves `@`, so the count is the
  // same either way.
  async commitsBehind(workspacePath, ref) {
    if (!existsSync(workspacePath)) return null;
    try {
      // `<ref>..trunk()` is the set of commits reachable from trunk
      // but not from ref — exactly the staleness number. Template `"x\n"`
      // gives one line per commit, which we count.
      const out = await run(
        "jj",
        [
          "log",
          "--ignore-working-copy",
          "-r",
          `${ref}..trunk()`,
          "--no-graph",
          "--no-pager",
          "--color",
          "never",
          "--template",
          '"x\\n"',
        ],
        workspacePath,
      );
      if (out.length === 0) return 0;
      return out.split("\n").filter((l) => l.length > 0).length;
    } catch {
      return null;
    }
  },

  // Rebase the workspace's @ onto `fromRef` (default = `trunk()`).
  // jj is always-snapshotted so dirty WC is never an issue — the auto-
  // snapshot becomes part of the rebase. After the rebase we query
  // `conflict()` to surface any commits that ended up conflicted; jj
  // doesn't auto-abort on conflicts (they materialise as commits with
  // conflict markers), so the workspace is left in a state the
  // operator can resolve in-place.
  async rebaseTo(workspacePath, fromRef, previousParentRef) {
    if (!existsSync(workspacePath)) {
      throw new Error(`vcs jj: workspace path missing: ${workspacePath}`);
    }
    const target = fromRef ?? "trunk()";
    // @'s commit id before the rebase (reading it snapshots the WC
    // first). jj skips commits already in place, so an unchanged id
    // after the rebase means a no-op: nothing was replayed.
    const headBefore = await jjCommitId(workspacePath);
    await run("jj", ["rebase", "-d", target], workspacePath);
    const moved = (await jjCommitId(workspacePath)) !== headBefore;
    // Replayed = first-line descriptions of commits in (target..@),
    // oldest-first, one per line; empty when the rebase was a no-op.
    const replayedRaw = moved
      ? await run(
          "jj",
          [
            "log",
            "-r",
            `${target}..@`,
            "--no-graph",
            "--no-pager",
            "--color",
            "never",
            "--reversed",
            "--template",
            'description.first_line() ++ "\\n"',
          ],
          workspacePath,
        ).catch(() => "")
      : "";
    const replayed = replayedRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // Conflict surface: list change_ids of commits in the rebased
    // range that are conflicted. Empty = clean rebase.
    const conflictRaw = await run(
      "jj",
      [
        "log",
        "-r",
        `(${target}..@) & conflict()`,
        "--no-graph",
        "--no-pager",
        "--color",
        "never",
        "--template",
        'change_id.short() ++ "\\n"',
      ],
      workspacePath,
    ).catch(() => "");
    const conflicts = conflictRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (conflicts.length > 0) {
      // jj has no abort: the rebase stays with the conflicts. The row's
      // parent_ref is left alone; the operator resolves (or `jj op
      // undo`es) and re-runs refresh, whose clean no-op rebase records
      // the base the disk is on.
      throw new WorkspaceConflictError(workspacePath, target, conflicts, false);
    }
    // After `jj rebase -d <target>` the chain sits on <target>, so its
    // commit is the new fork point (the row's parent_ref), unless the
    // old fork point already descends from it and is still under @
    // (no-op refresh onto an older base): parent_ref never moves
    // backward. Omitted when the revset names zero or several commits.
    const targetId = await jjSingleCommitId(workspacePath, target);
    if (targetId === undefined) return { fromRef: target, replayed, conflicts: [] };
    const keepPrevious =
      previousParentRef !== undefined &&
      (await jjSingleCommitId(workspacePath, `${previousParentRef} & ${targetId}:: & ::@`)) !==
        undefined;
    const parentRef = keepPrevious ? previousParentRef : targetId;
    return { fromRef: target, parentRef, replayed, conflicts: [] };
  },

  // List jj commits in (baseRef..@), oldest-first, minus @ itself when
  // it is the empty, undescribed working-copy commit jj snapshots on
  // every command: that is "no work yet", not a commit. jj's templating
  // gives us per-field strings; we glue them with NUL field-separators
  // and \x1e record-separators so multi-line descriptions/bodies
  // round-trip cleanly. The author timestamp template is
  // `author.timestamp().format("%Y-%m-%dT%H:%M:%S%:z")` which is
  // ISO-8601 (matches git's --aiso strict / --aI).
  async commitsSinceBase(workspacePath, baseRef) {
    if (!existsSync(workspacePath)) {
      throw new Error(`vcs jj: workspace path missing: ${workspacePath}`);
    }
    const out = await run(
      "jj",
      [
        "log",
        "-r",
        `(${baseRef}..@) ~ (@ & empty() & description(exact:""))`,
        "--no-graph",
        "--no-pager",
        "--color",
        "never",
        "--reversed",
        "--template",
        jjCommitSummaryTemplate,
      ],
      workspacePath,
    );
    return parseNulRecords(out);
  },

  async recentCommits(projectRoot, limit) {
    if (!existsSync(projectRoot)) {
      throw new Error(`vcs jj: project root missing: ${projectRoot}`);
    }
    const n = saneLimit(limit);
    if (n === 0) return [];
    const out = await run(
      "jj",
      [
        "log",
        "--no-graph",
        "--no-pager",
        "--color",
        "never",
        "-r",
        "::@",
        "--limit",
        String(n),
        "--template",
        jjCommitSummaryTemplate,
      ],
      projectRoot,
    );
    return parseNulRecords(out);
  },

  async showCommit(projectRoot, sha) {
    return runShow("jj", ["show", sha, "--color", "always"], projectRoot);
  },

  // jj is always-snapshotted: there is no "uncommitted" state. The
  // working copy is itself a commit; the next snapshot folds any
  // edits in. Surface that by returning [] so dirty-checking callers
  // never refuse a jj workspace as "dirty".
  async listDirtyFiles(_workspacePath) {
    return [];
  },
};

const jjCommitSummaryTemplate =
  'commit_id ++ "\\x00" ++ description.first_line() ++ "\\x00" ++ description ++ "\\x00" ++ author.timestamp().format("%Y-%m-%dT%H:%M:%S%:z") ++ "\\x00" ++ author.name() ++ "\\x1e"';

/** jj workspace name for a mu workspace path:
 *  <state>/workspaces/auth/worker-1 → auth/worker-1. Workstream and
 *  agent names cannot contain "/", so the name is unique per repo. */
export function jjWorkspaceName(workspacePath: string): string {
  const parts = workspacePath.split("/").filter((p) => p.length > 0);
  return parts.slice(-2).join("/") || workspacePath;
}

// Forget `name` if jj still registers it but its root dir is gone (the
// dir was rm -rf'd, or freed while already missing). jj reports such a
// workspace's root as "". Best-effort: on a jj without the
// `WorkspaceRef.root()` template, `workspace add` reports the clash.
async function forgetIfRootMissing(name: string, projectRoot: string): Promise<void> {
  try {
    const out = await run(
      "jj",
      [
        "workspace",
        "list",
        "--color",
        "never",
        "--template",
        'name ++ "\\x00" ++ self.root() ++ "\\x1e"',
      ],
      projectRoot,
    );
    const stale = out
      .split("\x1e")
      .map((r) => r.trim().split("\x00"))
      .some(([n, root]) => n === name && root === "");
    if (stale) await run("jj", ["workspace", "forget", name], projectRoot);
  } catch {
    // best-effort; `workspace add` surfaces any remaining conflict
  }
}

async function jjSingleCommitId(
  workspacePath: string,
  revset: string,
): Promise<string | undefined> {
  const out = await run(
    "jj",
    [
      "log",
      "-r",
      revset,
      "--no-graph",
      "--no-pager",
      "--color",
      "never",
      "--template",
      'commit_id ++ "\\n"',
    ],
    workspacePath,
  ).catch(() => "");
  const ids = out.split("\n").filter((l) => l.length > 0);
  return ids.length === 1 ? ids[0] : undefined;
}

async function jjCommitId(workspacePath: string): Promise<string> {
  return run(
    "jj",
    ["log", "-r", "@", "--no-graph", "--no-pager", "--color", "never", "--template", "commit_id"],
    workspacePath,
  );
}
