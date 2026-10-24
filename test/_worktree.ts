// Test helper: an agent row plus a real registered worktree, as `spawn --worktree` leaves them.

import { insertAgent } from "../src/agents.js";
import type { Db } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import {
  createWorktree,
  registerWorktree,
  type WorktreeRow,
  worktreePath,
} from "../src/worktree.js";

export async function seedWorktree(
  db: Db,
  opts: { root: string; workstream: string; agent: string; paneId?: string; from?: string },
): Promise<WorktreeRow> {
  const path = worktreePath(opts.workstream, opts.agent);
  const { base } = await createWorktree({
    root: opts.root,
    path,
    ...(opts.from !== undefined ? { from: opts.from } : {}),
  });
  ensureWorkstream(db, opts.workstream);
  insertAgent(db, {
    name: opts.agent,
    workstream: opts.workstream,
    paneId: opts.paneId ?? "%1",
    cwd: path,
    base,
  });
  const createdAt = new Date().toISOString();
  registerWorktree(db, {
    path,
    agent: opts.agent,
    workstream: opts.workstream,
    root: opts.root,
    base,
    createdAt,
  });
  return {
    path,
    agent: opts.agent,
    workstream: opts.workstream,
    root: opts.root,
    base,
    lastCollectedHead: null,
    createdAt,
  };
}
