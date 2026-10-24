// git primitives (src/vcs/git.ts): toplevel detection, owning root, the
// upstream set and ancestry, against real repos.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitToplevel, isAncestor, owningRoot, upstreamRefs } from "../src/vcs/git.js";
import { commitFileIn, gitIn, initGitRepo } from "./_git.js";

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "mu-vcs-git-")));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  initGitRepo(repo);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("gitToplevel / owningRoot", () => {
  it("finds the toplevel from a subdirectory and none outside a repo", async () => {
    mkdirSync(join(repo, "sub"));
    expect(await gitToplevel(join(repo, "sub"))).toBe(repo);
    expect(await gitToplevel(tmp)).toBeUndefined();
  });

  it("a worktree's owning root is the main checkout (.git is a pointer file there)", async () => {
    const wt = join(tmp, "wt");
    gitIn(repo, "worktree", "add", "-q", "--detach", wt);
    expect(await gitToplevel(wt)).toBe(wt);
    expect(await owningRoot(wt)).toBe(repo);
  });
});

describe("upstreamRefs / isAncestor", () => {
  it("is base plus the root's HEAD, deduped, and starts with base", async () => {
    const base = gitIn(repo, "rev-parse", "HEAD");
    expect(await upstreamRefs(repo, base)).toEqual([base]);
    const later = commitFileIn(repo, "later.txt", "later");
    expect(await upstreamRefs(repo, base)).toEqual([base, later]);
  });

  it("includes origin/HEAD when it resolves", async () => {
    const bare = join(tmp, "origin.git");
    gitIn(tmp, "init", "-q", "--bare", "-b", "main", bare);
    gitIn(repo, "remote", "add", "origin", bare);
    gitIn(repo, "push", "-q", "origin", "main");
    gitIn(repo, "remote", "set-head", "origin", "main");
    const base = gitIn(repo, "rev-parse", "HEAD");
    commitFileIn(repo, "local.txt", "local only");
    const refs = await upstreamRefs(repo, base);
    expect(refs).toContain(base);
    expect(refs).toContain(gitIn(repo, "rev-parse", "HEAD"));
  });

  it("isAncestor: a merged sha yes, a side branch no", async () => {
    const base = gitIn(repo, "rev-parse", "HEAD");
    gitIn(repo, "checkout", "-q", "-b", "side");
    const side = commitFileIn(repo, "side.txt", "side");
    gitIn(repo, "checkout", "-q", "main");
    expect(await isAncestor(repo, base)).toBe(true);
    expect(await isAncestor(repo, side)).toBe(false);
  });
});
