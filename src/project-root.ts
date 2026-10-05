// mu — VCS-derived project root helpers.
//
// Used by the TUI launch-focus heuristic to connect a registered
// per-agent workspace back to the project root the human is likely
// standing in. Kept outside src/cli/ so it stays a small reusable SDK
// helper with no ink/react imports.

import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import type { VcsBackendName } from "./vcs.js";

const exec = promisify(execFile);

async function run(bin: string, args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await exec(bin, [...args], { cwd, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function gitProjectRoot(workspacePath: string): Promise<string | null> {
  try {
    const commonDir = await run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      workspacePath,
    );
    if (commonDir.length === 0) return null;
    return realpathOrResolve(dirname(commonDir));
  } catch {
    return null;
  }
}

async function slProjectRoot(workspacePath: string): Promise<string | null> {
  try {
    const root = await run("sl", ["root"], workspacePath);
    if (root.length === 0) return null;
    return realpathOrResolve(root);
  } catch {
    return null;
  }
}

// A jj workspace made by `jj workspace add` has no .git; its
// `.jj/repo` is a file holding the path (relative to `.jj/`) of the
// main workspace's `.jj/repo` store. The main workspace's own
// `.jj/repo` is that store directory.
async function jjProjectRoot(workspacePath: string): Promise<string | null> {
  const dotJj = resolve(workspacePath, ".jj");
  const repo = resolve(dotJj, "repo");
  try {
    if ((await stat(repo)).isDirectory()) return realpathOrResolve(workspacePath);
    const store = resolve(dotJj, (await readFile(repo, "utf8")).trim());
    return realpathOrResolve(dirname(dirname(store)));
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical project root for a registered workspace path.
 *
 * - git: parent of `git rev-parse --git-common-dir`, so git worktrees
 *   map back to the main checkout's project root rather than the
 *   per-agent worktree directory.
 * - jj: the directory holding the repo store that the workspace's
 *   `.jj/repo` pointer names (the main workspace), git-backed or not.
 * - sl: `sl root` is the project root.
 * - none: no VCS relationship to infer.
 */
export async function workspaceProjectRoot(
  workspacePath: string,
  backend: VcsBackendName,
): Promise<string | null> {
  if (backend === "none") return null;
  if (backend === "git") return gitProjectRoot(workspacePath);
  if (backend === "sl") return slProjectRoot(workspacePath);
  return jjProjectRoot(workspacePath);
}
