// mu — per-agent git worktrees: creation, the machine-local registry, and
// the one close rule shared by `agent close`, orphan close and teardown.
//
// A worker's cwd IS its worktree (`spawn --worktree`). Git only; the
// worktree is `git worktree add --detach` because a named branch would
// break name reuse. A branch is made only to keep unmerged commits.
//
// The registry (`worktrees`, machine-local) is NOT keyed to the agent: it
// outlives the agent row so a reused name can tell its own clean leftover
// from foreign work, and so close can still finish an orphaned worktree.
// The reaper (reconcile) never touches a worktree or the registry; cleanup
// is `agent close` / teardown, never a side effect of listing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { defaultStateDir } from "./db.js";
import type { HasNextSteps, NextStep } from "./output.js";
import {
  addWorktree,
  createBranch,
  dirtyFiles,
  gitToplevel,
  headSha,
  ownCommits,
  owningRoot,
  removeWorktreeDir,
  upstreamRefs,
} from "./vcs/git.js";

export { upstreamRefs } from "./vcs/git.js";

// ─── errors ────────────────────────────────────────────────────────────

/** `--worktree` was asked of a root that is not inside a git repo. Exit 4. */
export class WorktreeVcsRequiredError extends Error implements HasNextSteps {
  override readonly name = "WorktreeVcsRequiredError";
  constructor(public readonly root: string) {
    super(`--worktree requires a git repository; ${root} is not inside one`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Run from inside a git repo, or name one",
        command: "mu agent spawn <agent> --worktree --root <git-repo>",
      },
    ];
  }
}

/** Most dirty paths an error lists. */
const MAX_DIRTY_LISTED = 10;

/**
 * `agent close` (or teardown) refused: the worktree has uncommitted work.
 * `--discard` overrides. Exit 4.
 */
export class WorktreeDirtyError extends Error implements HasNextSteps {
  override readonly name = "WorktreeDirtyError";
  constructor(
    public readonly agent: string,
    public readonly workstream: string,
    public readonly path: string,
    public readonly files: readonly string[],
  ) {
    const shown = files.slice(0, MAX_DIRTY_LISTED);
    const more = files.length - shown.length;
    super(
      `agent ${agent} has uncommitted work in ${path}; refusing to close: ${
        shown.length > 0 ? shown.join(", ") : "git status unreadable"
      }${more > 0 ? ` (+${more} more)` : ""}`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Look at the changes", command: `git -C ${this.path} status --short` },
      {
        intent: "Commit them, then close",
        command: `git -C ${this.path} add -A && git -C ${this.path} commit -m <message>`,
      },
      {
        intent: "Or preview throwing the changes away (lossy; the preview prints the --if apply)",
        command: `mu agent close ${this.agent} -w ${this.workstream} --discard`,
      },
    ];
  }
}

/**
 * Spawn found a worktree dir at the agent's path that is not its own clean
 * leftover (dirty, new commits, or not made by mu). Exit 4.
 */
export class WorktreePathNotEmptyError extends Error implements HasNextSteps {
  override readonly name = "WorktreePathNotEmptyError";
  constructor(
    public readonly agent: string,
    public readonly workstream: string,
    public readonly path: string,
    public readonly why: string,
  ) {
    super(
      `worktree dir already on disk for agent ${agent} (${path}): ${why}; refusing to overwrite`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Keep it: preview closing it (an unmerged commit keeps a branch; dirty refuses)",
        command: `mu agent close ${this.agent} -w ${this.workstream}`,
      },
      {
        intent: "Or preview throwing it away (lossy)",
        command: `mu agent close ${this.agent} -w ${this.workstream} --discard`,
      },
      {
        intent: "Or spawn under another name",
        command: "mu agent spawn <agent> --next-free --worktree",
      },
    ];
  }
}

// ─── paths ─────────────────────────────────────────────────────────────

/** `<state dir>/worktrees`: where mu puts the worktrees it creates. */
export function worktreesRoot(): string {
  return join(defaultStateDir(), "worktrees");
}

/** The canonical path of an agent's worktree. */
export function worktreePath(workstream: string, agent: string): string {
  return join(worktreesRoot(), workstream, agent);
}

// ─── git-level operations ──────────────────────────────────────────────

/**
 * `git -C root worktree add --detach path [from]`. Returns the commit the
 * worktree is at. The caller registers it.
 */
export async function createWorktree(opts: {
  root: string;
  path: string;
  from?: string;
}): Promise<{ base: string }> {
  return { base: await addWorktree(opts.root, opts.path, opts.from) };
}

/** Remove a worktree. `force` also drops uncommitted work. */
export async function removeWorktree(
  root: string,
  path: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  await removeWorktreeDir(root, path, opts.force === true);
}

/** The usable checkout of a worktree's repo: the recorded root, else git's own pointer. */
async function liveRoot(root: string, path: string): Promise<string | undefined> {
  if (root.length > 0 && (await gitToplevel(root)) !== undefined) return root;
  return owningRoot(path);
}

export type WorktreeState = "dirty" | "clean-merged" | "clean-unmerged" | "missing";

/**
 * Where a worktree stands, for the close rule:
 *   missing         the dir is gone
 *   dirty           uncommitted work, or git cannot say (unverifiable counts as dirty)
 *   clean-merged    clean and every commit is already upstream: HEAD is `base`,
 *                   or reachable from the root's HEAD / origin/HEAD / @{upstream}
 *   clean-unmerged  clean with commits of its own
 * `base` may be empty (a row migrated without one): then only the root's refs count.
 */
export async function worktreeState(
  path: string,
  base: string,
  root: string,
): Promise<WorktreeState> {
  if (!existsSync(path)) return "missing";
  try {
    if ((await dirtyFiles(path)).length > 0) return "dirty";
  } catch {
    return "dirty";
  }
  try {
    const owner = (await liveRoot(root, path)) ?? path;
    const refs = (await upstreamRefs(owner, base)).filter((r) => r.length > 0);
    return (await ownCommits(path, refs)).length === 0 ? "clean-merged" : "clean-unmerged";
  } catch {
    return "clean-unmerged";
  }
}

// ─── the registry ──────────────────────────────────────────────────────

export interface WorktreeRow {
  path: string;
  agent: string;
  workstream: string;
  /** The checkout the worktree was added from ("" when unknown: migrated rows). */
  root: string;
  /** The commit the worktree was created at ("" when unknown). */
  base: string;
  /** HEAD last brought back by a collect; reuse and removal accept it like `base`. */
  lastCollectedHead: string | null;
  createdAt: string;
}

interface RawWorktreeRow {
  path: string;
  agent: string;
  workstream: string;
  root: string;
  base: string;
  last_collected_head: string | null;
  created_at: string;
}

function fromRaw(r: RawWorktreeRow): WorktreeRow {
  return {
    path: r.path,
    agent: r.agent,
    workstream: r.workstream,
    root: r.root,
    base: r.base,
    lastCollectedHead: r.last_collected_head,
    createdAt: r.created_at,
  };
}

export function registerWorktree(db: Db, row: Omit<WorktreeRow, "lastCollectedHead">): void {
  db.prepare(
    `INSERT OR REPLACE INTO worktrees (path, agent, workstream, root, base, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.path, row.agent, row.workstream, row.root, row.base, row.createdAt);
}

export function forgetWorktree(db: Db, path: string): void {
  db.prepare("DELETE FROM worktrees WHERE path = ?").run(path);
}

export function getWorktreeAt(db: Db, path: string): WorktreeRow | undefined {
  const r = db.prepare("SELECT * FROM worktrees WHERE path = ?").get(path) as
    | RawWorktreeRow
    | undefined;
  return r ? fromRaw(r) : undefined;
}

/** The registry row of an agent's worktree (newest when a name was reused). */
export function getWorktreeFor(db: Db, workstream: string, agent: string): WorktreeRow | undefined {
  const r = db
    .prepare(
      `SELECT * FROM worktrees WHERE workstream = ? AND agent = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(workstream, agent) as RawWorktreeRow | undefined;
  return r ? fromRaw(r) : undefined;
}

export function listWorktrees(db: Db, workstream?: string): WorktreeRow[] {
  const rows =
    workstream === undefined
      ? db.prepare("SELECT * FROM worktrees ORDER BY workstream, agent, path").all()
      : db
          .prepare("SELECT * FROM worktrees WHERE workstream = ? ORDER BY agent, path")
          .all(workstream);
  return (rows as RawWorktreeRow[]).map(fromRaw);
}

// ─── name reuse (spawn) ────────────────────────────────────────────────

/**
 * Make `path` free for a new worktree of `agent`. Nothing on disk: fine (a
 * stale registry row is forgotten). A worktree there is removed only if mu
 * made it, it is clean, and HEAD is the base (or the last collected head):
 * its own unused leftover. Anything else refuses with one line: no branch
 * is made on reuse.
 */
export async function reclaimWorktreePath(
  db: Db,
  opts: { agent: string; workstream: string; path: string },
): Promise<void> {
  const { agent, workstream, path } = opts;
  const row = getWorktreeAt(db, path);
  if (!existsSync(path)) {
    if (row !== undefined) forgetWorktree(db, path);
    return;
  }
  const refuse = (why: string) => new WorktreePathNotEmptyError(agent, workstream, path, why);
  if (row === undefined) throw refuse("not a worktree mu registered");
  let files: string[];
  let head: string;
  try {
    files = await dirtyFiles(path);
    head = await headSha(path);
  } catch {
    throw refuse("git cannot read it");
  }
  if (files.length > 0) throw refuse(`uncommitted work (${files.length} file(s))`);
  if (head !== row.base && head !== row.lastCollectedHead) {
    throw refuse(`commits of its own (HEAD ${head.slice(0, 12)})`);
  }
  await removeWorktreeDir((await liveRoot(row.root, path)) ?? undefined, path, false);
  forgetWorktree(db, path);
}

// ─── the close rule ────────────────────────────────────────────────────

export interface ReleasedWorktree {
  path: string;
  /** What happened on disk. `gone`: the dir was already missing. */
  action: "removed" | "kept-branch" | "discarded" | "gone";
  /** The branch made to keep unmerged commits. */
  branch?: string;
}

/**
 * Refuse a dirty worktree unless `discard`. Checked before any effect so a
 * caller can refuse before it kills a pane.
 */
export async function assertReleasable(
  row: WorktreeRow,
  opts: { discard?: boolean },
): Promise<WorktreeState> {
  const state = await worktreeState(row.path, row.base, row.root);
  if (state === "dirty" && opts.discard !== true) {
    let files: string[] = [];
    try {
      files = await dirtyFiles(row.path);
    } catch {
      // unreadable: the error says so
    }
    throw new WorktreeDirtyError(row.agent, row.workstream, row.path, files);
  }
  return state;
}

/**
 * The one close rule (README § Worktrees):
 *   dirty            refuse (WorktreeDirtyError) unless `discard`, which removes it
 *   clean, merged    remove
 *   clean, unmerged  make `mu/<ws>/<agent>-<sha12>` at HEAD in the root repo, then remove
 *   missing          forget the row
 * The registry row is forgotten once the dir is handled. Re-checks the state
 * itself: a write between a caller's pre-check and this call still refuses.
 */
export async function releaseWorktree(
  db: Db,
  row: WorktreeRow,
  opts: { discard?: boolean } = {},
): Promise<ReleasedWorktree> {
  const state = await assertReleasable(row, opts);
  const owner = await liveRoot(row.root, row.path);
  if (state === "missing") {
    if (owner !== undefined) await removeWorktreeDir(owner, row.path, false);
    forgetWorktree(db, row.path);
    return { path: row.path, action: "gone" };
  }
  if (opts.discard === true) {
    await removeWorktreeDir(owner, row.path, true);
    forgetWorktree(db, row.path);
    return { path: row.path, action: "discarded" };
  }
  if (state === "clean-unmerged") {
    if (owner === undefined) {
      throw new Error(
        `worktree ${row.path} has unmerged commits and its repo is gone; nothing can keep them (use --discard to drop them)`,
      );
    }
    const sha = await headSha(row.path);
    const branch = `mu/${row.workstream}/${row.agent}-${sha.slice(0, 12)}`;
    await createBranch(owner, branch, sha);
    await removeWorktreeDir(owner, row.path, false);
    forgetWorktree(db, row.path);
    return { path: row.path, action: "kept-branch", branch };
  }
  // clean-merged. Without --force git itself refuses a write that raced the check.
  try {
    await removeWorktreeDir(owner, row.path, false);
  } catch (err) {
    if (existsSync(row.path)) {
      let files: string[] = [];
      try {
        files = await dirtyFiles(row.path);
      } catch {
        // fall through with an empty list
      }
      if (files.length > 0)
        throw new WorktreeDirtyError(row.agent, row.workstream, row.path, files);
    }
    throw err;
  }
  forgetWorktree(db, row.path);
  return { path: row.path, action: "removed" };
}
