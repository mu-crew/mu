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

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import { defaultStateDir } from "./db.js";
import { say } from "./messages.js";
import {
  addWorktree,
  createBranch,
  dirtyFiles,
  git,
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
export class WorktreeVcsRequiredError extends Error {
  override readonly name = "WorktreeVcsRequiredError";
  constructor(public readonly root: string) {
    super(say("worktree.vcs_required", root));
  }
}

/** Most dirty paths an error lists. */
const MAX_DIRTY_LISTED = 10;

/**
 * `agent close` (or teardown) refused: the worktree has uncommitted work.
 * `--discard` overrides. Exit 4.
 */
export class WorktreeDirtyError extends Error {
  override readonly name = "WorktreeDirtyError";
  constructor(
    public readonly agent: string,
    public readonly workstream: string,
    public readonly path: string,
    public readonly files: readonly string[],
  ) {
    const shown = files.slice(0, MAX_DIRTY_LISTED);
    const more = files.length - shown.length;
    super(say("worktree.dirty", agent, path, shown, more));
  }
}

/**
 * Spawn found a worktree dir at the agent's path that is not its own clean
 * leftover (dirty, new commits, or not made by mu). Exit 4.
 */
export class WorktreePathNotEmptyError extends Error {
  override readonly name = "WorktreePathNotEmptyError";
  constructor(
    public readonly agent: string,
    public readonly workstream: string,
    public readonly path: string,
    public readonly why: string,
  ) {
    super(say("worktree.path_not_empty", agent, path, why));
  }
}

/**
 * Close would keep unmerged commits on `mu/<ws>/<agent>-<sha12>`, but a branch
 * of that name already points at another commit. It is never moved; the
 * worktree and its registry row are kept. Exit 4.
 */
export class WorktreeBranchExistsError extends Error {
  override readonly name = "WorktreeBranchExistsError";
  constructor(
    public readonly agent: string,
    public readonly workstream: string,
    public readonly path: string,
    public readonly branch: string,
  ) {
    super(say("worktree.branch_exists", agent, workstream, path, branch));
  }
}

/**
 * `agent close` refused to remove a worktree something may still use: a
 * process has a file in it open for writing (`holder`), or no scan could
 * prove there is none (`holder` undefined). `--force` overrides either. The
 * tree, its registry row and the agent row are kept. Exit 4.
 */
export class WorktreeHeldError extends Error {
  override readonly name = "WorktreeHeldError";
  constructor(
    public readonly agent: string,
    public readonly workstream: string,
    public readonly path: string,
    public readonly holder: WorktreeHolder | undefined,
  ) {
    super(say("worktree.held", agent, workstream, path, holder));
  }
  /** The writer's pid; undefined when the refusal is an unprovable scan. */
  get pid(): number | undefined {
    return this.holder?.pid;
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
  signal?: AbortSignal;
}): Promise<{ base: string }> {
  return { base: await addWorktree(opts.root, opts.path, opts.from, opts.signal) };
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
  if (existsSync(asideOfLocal(path))) {
    throw new WorktreePathNotEmptyError(
      agent,
      workstream,
      path,
      `an interrupted close parked it at ${asideOfLocal(path)}; finish it: mu agent close ${agent} -w ${workstream}`,
    );
  }
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
  /** Processes still in the tree when it was removed (their cwd, a read-only file; or, under `force`, a writer). */
  warnings?: string[];
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

/** Where `releaseWorktree` parks a tree while it proves nothing holds it. */
export const asideOfLocal = (path: string): string => `${path}.mu-removing`;

const exec = promisify(execFile);

/** True when `target` is `dir` or under it. */
const under = (target: string, dir: string): boolean =>
  target === dir || target.startsWith(`${dir}/`);

/**
 * A process found in a worktree. `writer`: it has a file there open for
 * writing (the one kind whose work a removal can lose); else its cwd or a
 * read-only file is there, which a close reports and goes past.
 */
export interface WorktreeHolder {
  pid: number;
  /** Its command name (`/proc/<pid>/comm`, lsof's `c`), "" when unknown. */
  command: string;
  writer: boolean;
}

/** `/proc/<pid>/fdinfo/<fd>` flags: O_WRONLY or O_RDWR. Unreadable counts as writing. */
function fdWrites(fdinfo: string): boolean {
  let text: string;
  try {
    text = readFileSync(fdinfo, "utf8");
  } catch {
    return true;
  }
  const m = /^flags:\s*([0-7]+)/m.exec(text);
  return m?.[1] === undefined || (Number.parseInt(m[1], 8) & 3) !== 0;
}

/**
 * Processes of this user with their cwd or an open file at or under `dir`
 * (this process excluded: a close run from inside the tree writes nothing
 * there). Reads /proc, else `lsof`; undefined when neither demonstrably ran
 * (the scan must see this very process). `probe` is a test seam.
 */
export async function worktreeHolders(
  dir: string,
  probe: { proc: string; lsof: string } = { proc: "/proc", lsof: "lsof" },
): Promise<WorktreeHolder[] | undefined> {
  const held = new Map<number, WorktreeHolder>();
  const add = (pid: number, command: string, writer: boolean): void => {
    const h = held.get(pid);
    if (h === undefined) held.set(pid, { pid, command, writer });
    else h.writer ||= writer;
  };
  let sawSelf = false;
  if (existsSync(join(probe.proc, "self"))) {
    for (const ent of readdirSync(probe.proc)) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = Number(ent);
      const link = (p: string): string | undefined => {
        try {
          return readlinkSync(p);
        } catch {
          return undefined; // gone, or another user's
        }
      };
      const cwd = link(join(probe.proc, ent, "cwd"));
      if (pid === process.pid) {
        sawSelf = cwd !== undefined;
        continue;
      }
      let command: string | undefined;
      const name = (): string => {
        if (command === undefined) {
          try {
            command = readFileSync(join(probe.proc, ent, "comm"), "utf8").trim();
          } catch {
            command = "";
          }
        }
        return command;
      };
      if (cwd !== undefined && under(cwd, dir)) add(pid, name(), false);
      let fds: string[] = [];
      try {
        fds = readdirSync(join(probe.proc, ent, "fd"));
      } catch {
        // gone, or another user's
      }
      for (const fd of fds) {
        const t = link(join(probe.proc, ent, "fd", fd));
        if (t !== undefined && under(t, dir))
          add(pid, name(), fdWrites(join(probe.proc, ent, "fdinfo", fd)));
      }
    }
    return sawSelf ? [...held.values()] : undefined;
  }
  let out: string;
  try {
    out = (await exec(probe.lsof, ["-w", "-Fpcfan"], { maxBuffer: 256 * 1024 * 1024 })).stdout;
  } catch (err) {
    // lsof exits 1 when some files could not be read; its output still counts.
    const o = (err as { stdout?: unknown }).stdout;
    if (typeof o !== "string" || o === "") return undefined;
    out = o;
  }
  let pid = 0;
  let command = "";
  let field = "";
  let access = "";
  for (const l of out.split("\n")) {
    if (l.startsWith("p")) {
      pid = Number(l.slice(1));
      command = "";
    } else if (l.startsWith("c")) command = l.slice(1);
    else if (l.startsWith("f")) {
      field = l.slice(1);
      access = "";
    } else if (l.startsWith("a")) access = l.slice(1).trim();
    else if (l.startsWith("n")) {
      if (pid === process.pid) sawSelf ||= field === "cwd";
      else if (under(l.slice(1), dir))
        // An fd (numeric field) not known to be read-only counts as writing.
        add(pid, command, /^\d+$/.test(field) && access !== "r");
    }
  }
  return sawSelf ? [...held.values()] : undefined;
}

/**
 * Move a worktree (`git worktree move` while its repo lives, so git keeps
 * tracking it; a plain rename once the repo is gone).
 */
async function moveTree(owner: string | undefined, from: string, to: string): Promise<void> {
  if (owner === undefined) renameSync(from, to);
  else await git(["worktree", "move", from, to], owner);
}

/**
 * The one close rule (README § Worktrees):
 *   dirty            refuse (WorktreeDirtyError) unless `discard`, which removes it
 *   clean, merged    remove
 *   clean, unmerged  make `mu/<ws>/<agent>-<sha12>` at HEAD in the root repo, then remove
 *   missing          forget the row
 * The registry row is forgotten once the dir is handled. Re-checks the state
 * itself: a write between a caller's pre-check and this call still refuses.
 *
 * Quiescence before any branch or removal, the remote close rule's local
 * twin: the tree is parked at `asideOfLocal(path)` (a writer addressing the
 * old path now fails), `worktreeHolders` must prove no process has its cwd or
 * an open file in it, and the state is judged again under the park. A file
 * open for writing refuses (`WorktreeHeldError`), as does a scan that cannot
 * run; `force` overrides both. A process with only its cwd or a read-only
 * file there (a shell cd'd in, a reader, a dashboard) loses nothing: it is
 * named in `warnings` and the close goes on. Any refusal moves the tree back. A park a crash left is moved
 * back first, then the rule runs again.
 */
export async function releaseWorktree(
  db: Db,
  row: WorktreeRow,
  opts: { discard?: boolean; force?: boolean; probe?: { proc: string; lsof: string } } = {},
): Promise<ReleasedWorktree> {
  const aside = asideOfLocal(row.path);
  if (existsSync(aside)) {
    if (existsSync(row.path)) {
      throw new WorktreePathNotEmptyError(
        row.agent,
        row.workstream,
        row.path,
        `a parked copy is beside it at ${aside}; move or remove one by hand`,
      );
    }
    await moveTree(await liveRoot(row.root, aside), aside, row.path);
  }
  const before = await assertReleasable(row, opts);
  const owner = await liveRoot(row.root, row.path);
  if (before === "missing") {
    if (owner !== undefined) await removeWorktreeDir(owner, row.path, false);
    forgetWorktree(db, row.path);
    return { path: row.path, action: "gone" };
  }
  await moveTree(owner, row.path, aside);
  const parked: WorktreeRow = { ...row, path: aside };
  try {
    const holders = await worktreeHolders(aside, opts.probe);
    const writer = holders?.find((h) => h.writer);
    if ((holders === undefined || writer !== undefined) && opts.force !== true) {
      throw new WorktreeHeldError(row.agent, row.workstream, row.path, writer);
    }
    // Nothing a removal can lose: say who is still there, and go on.
    const warnings = (holders ?? []).map((h) => say("worktree.holder_left", row.path, h));
    const said = warnings.length > 0 ? { warnings } : {};
    // Judged again under the park: a write that raced the first check counts.
    const state = await assertReleasable(parked, opts);
    if (state === "missing") throw new Error(`worktree ${aside} vanished while closing`);
    if (opts.discard === true) {
      await removeWorktreeDir(owner, aside, true);
      forgetWorktree(db, row.path);
      return { path: row.path, action: "discarded", ...said };
    }
    if (state === "clean-unmerged") {
      if (owner === undefined) throw new Error(say("worktree.unmerged_repo_gone", row.path));
      const sha = await headSha(aside);
      const branch = `mu/${row.workstream}/${row.agent}-${sha.slice(0, 12)}`;
      // Create-only: a retry finds its own branch at this HEAD and goes on.
      if (!(await createBranch(owner, branch, sha))) {
        throw new WorktreeBranchExistsError(row.agent, row.workstream, row.path, branch);
      }
      await removeWorktreeDir(owner, aside, false);
      forgetWorktree(db, row.path);
      return { path: row.path, action: "kept-branch", branch, ...said };
    }
    // clean-merged. Without --force git itself refuses a write that raced the check.
    try {
      await removeWorktreeDir(owner, aside, false);
    } catch (err) {
      let files: string[] = [];
      try {
        files = existsSync(aside) ? await dirtyFiles(aside) : [];
      } catch {
        // fall through with an empty list
      }
      if (files.length > 0)
        throw new WorktreeDirtyError(row.agent, row.workstream, row.path, files);
      throw err;
    }
    forgetWorktree(db, row.path);
    return { path: row.path, action: "removed", ...said };
  } catch (err) {
    // Nothing was removed: put the tree back where its agent and registry say it is.
    if (existsSync(aside) && !existsSync(row.path)) await moveTree(owner, aside, row.path);
    // A dirty refusal names the real path, not the park.
    if (err instanceof WorktreeDirtyError && err.path === aside) {
      throw new WorktreeDirtyError(row.agent, row.workstream, row.path, err.files);
    }
    throw err;
  }
}
