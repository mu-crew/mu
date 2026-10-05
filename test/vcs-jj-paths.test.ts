// Fast-tier tests for the jj path helpers that need no jj binary:
// the jj workspace name a mu workspace path gets, and the project root
// read from a workspace's `.jj/repo` pointer. Real-jj coverage lives in
// test/workspace-backends.integration.test.ts.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { workspaceProjectRoot } from "../src/project-root.js";
import { jjWorkspaceName } from "../src/vcs/jj.js";

describe("jjWorkspaceName", () => {
  it("is <workstream>/<agent>, so same-named agents in two workstreams differ", () => {
    const a = jjWorkspaceName("/s/workspaces/auth/worker-1");
    const b = jjWorkspaceName("/s/workspaces/billing/worker-1");
    expect(a).toBe("auth/worker-1");
    expect(b).toBe("billing/worker-1");
  });

  it("ignores a trailing slash", () => {
    expect(jjWorkspaceName("/s/workspaces/auth/worker-1/")).toBe("auth/worker-1");
  });
});

describe("workspaceProjectRoot (jj)", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mu-jj-root-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Layout `jj workspace add` writes: the main workspace owns the
  // `.jj/repo` store dir; a secondary workspace's `.jj/repo` is a file
  // with the store path relative to its own `.jj/`.
  function layout(): { main: string; ws: string } {
    const main = join(dir, "project");
    mkdirSync(join(main, ".jj", "repo"), { recursive: true });
    const ws = join(dir, "state", "workspaces", "auth", "worker-1");
    mkdirSync(join(ws, ".jj"), { recursive: true });
    writeFileSync(join(ws, ".jj", "repo"), "../../../../../project/.jj/repo");
    return { main, ws };
  }

  it("maps a secondary workspace back to the main workspace, not its parent dir", async () => {
    const { main, ws } = layout();
    await expect(workspaceProjectRoot(ws, "jj")).resolves.toBe(main);
  });

  it("maps the main workspace to itself", async () => {
    const { main } = layout();
    await expect(workspaceProjectRoot(main, "jj")).resolves.toBe(main);
  });

  it("returns null when the path is not a jj workspace", async () => {
    await expect(workspaceProjectRoot(dir, "jj")).resolves.toBeNull();
  });
});
