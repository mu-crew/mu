// refreshWorkspace records the rebase's new fork point as the row's
// parent_ref (f_vcs_refresh_parent_ref). Without it, staleness,
// `mu workspace commits` and the close-time clean check kept measuring
// from the pre-refresh base. The backend is mocked; the real git
// rebase path is covered in workspace-refresh.integration.test.ts.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { gitBackend, type VcsBackend, WorkspaceConflictError } from "../src/vcs.js";
import { createWorkspace, getWorkspaceForAgent, refreshWorkspace } from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";

let root: string;
let db: Db;

const fakeGit: VcsBackend = {
  ...gitBackend,
  async createWorkspace(opts) {
    mkdirSync(opts.workspacePath, { recursive: true });
    return { parentRef: "old-base" };
  },
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "mu-refresh-parent-"));
  process.env.MU_STATE_DIR = join(root, "state");
  db = openDb({ path: join(root, "mu.db") });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });
  await createWorkspace(db, {
    agent: "worker-1",
    workstream: "auth",
    projectRoot: root,
    backend: fakeGit,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

function parentRef(): string | null | undefined {
  return getWorkspaceForAgent(db, "worker-1", "auth")?.parentRef;
}

describe("refreshWorkspace parent_ref", () => {
  it("writes the new fork point after a successful rebase", async () => {
    vi.spyOn(gitBackend, "rebaseTo").mockResolvedValue({
      fromRef: "refs/remotes/origin/HEAD",
      parentRef: "new-base",
      replayed: ["work"],
      conflicts: [],
    });
    expect(parentRef()).toBe("old-base");
    const r = await refreshWorkspace(db, { agent: "worker-1", workstream: "auth" });
    expect(r.parentRef).toBe("new-base");
    expect(parentRef()).toBe("new-base");
  });

  it("keeps the old value when the backend reports no fork point", async () => {
    vi.spyOn(gitBackend, "rebaseTo").mockResolvedValue({
      fromRef: "trunk()",
      replayed: [],
      conflicts: [],
    });
    await refreshWorkspace(db, { agent: "worker-1", workstream: "auth" });
    expect(parentRef()).toBe("old-base");
  });

  it("passes the current parent_ref so the backend never moves it backward", async () => {
    const spy = vi.spyOn(gitBackend, "rebaseTo").mockResolvedValue({
      fromRef: "origin/main",
      parentRef: "old-base",
      replayed: [],
      conflicts: [],
    });
    await refreshWorkspace(db, { agent: "worker-1", workstream: "auth", fromRef: "origin/main" });
    expect(spy).toHaveBeenCalledWith(expect.any(String), "origin/main", "old-base");
    expect(parentRef()).toBe("old-base");
  });

  it("keeps the old value when a conflicted rebase stayed in place (jj)", async () => {
    // The disk may be rolled back with `jj op undo`; the next clean
    // refresh records the base it is on (g_fix_vcs_git_conflict_parent_hint).
    vi.spyOn(gitBackend, "rebaseTo").mockRejectedValue(
      new WorkspaceConflictError("/ws", "trunk()", ["abc"], false),
    );
    await expect(refreshWorkspace(db, { agent: "worker-1", workstream: "auth" })).rejects.toThrow(
      WorkspaceConflictError,
    );
    expect(parentRef()).toBe("old-base");
  });

  it("keeps the old value when the backend aborted the conflicted rebase (git/sl)", async () => {
    vi.spyOn(gitBackend, "rebaseTo").mockRejectedValue(
      new WorkspaceConflictError("/ws", "origin/main", ["a.txt"]),
    );
    await expect(refreshWorkspace(db, { agent: "worker-1", workstream: "auth" })).rejects.toThrow(
      WorkspaceConflictError,
    );
    expect(parentRef()).toBe("old-base");
  });
});
