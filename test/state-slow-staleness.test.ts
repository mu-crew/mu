// Regression for f_wsstate_tui_behind_never: the TUI loads snapshots
// through loadWorkstreamSnapshotFast + loadWorkstreamSnapshotSlow, and
// neither used to call decorateWithStaleness, so the Workspaces card
// always showed "—" for commits behind main.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb, resolveWorkstreamId } from "../src/db.js";
import {
  loadWorkstreamSnapshotFast,
  loadWorkstreamSnapshotSlow,
  mergeSnapshotFastSlow,
} from "../src/state.js";

vi.mock("../src/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents.js")>();
  return {
    ...actual,
    listLiveAgents: vi.fn(async () => ({
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, orphans: [], mode: "full" },
    })),
  };
});

vi.mock("../src/vcs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vcs.js")>();
  return {
    ...actual,
    backendByName: vi.fn(() => ({
      commitsBehind: async () => 2,
      listDirtyFiles: async () => [],
    })),
  };
});

let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

describe("TUI snapshot tiers: workspace staleness", () => {
  it("the slow tier decorates workspaces with commitsBehindMain", async () => {
    db = openDb({ path: join(mkdtempSync(join(tmpdir(), "mu-state-slow-stale-")), "mu.db") });
    insertAgent(db, { name: "worker-1", workstream: "ws", paneId: "%1" });
    const wsId = resolveWorkstreamId(db, "ws");
    const agent = db.prepare("SELECT id FROM agents WHERE name = 'worker-1'").get() as {
      id: number;
    };
    db.prepare(
      `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
       VALUES (?, ?, 'git', '/tmp/ws/worker-1', 'base', '2026-01-01T00:00:00.000Z')`,
    ).run(agent.id, wsId);

    const fast = await loadWorkstreamSnapshotFast(db, "ws");
    const slow = await loadWorkstreamSnapshotSlow(db, "ws", { withDirty: true }, fast);
    expect(slow.workspaces.map((w) => w.commitsBehindMain)).toEqual([2]);
    const merged = mergeSnapshotFastSlow(fast, slow);
    expect(merged.workspaces.map((w) => [w.commitsBehindMain, w.dirty])).toEqual([[2, false]]);
  });
});
