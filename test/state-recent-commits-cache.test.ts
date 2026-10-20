// The TUI slow tick asks for recent commits every 10 s. Backend detection
// spawns up to 4 processes, so it must run once per project root; a `none`
// answer is not cached (a later `git init` is still noticed).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  loadWorkstreamSnapshotSlow,
  resetRecentCommitsBackendCacheForTests,
} from "../src/state.js";

const detect = vi.hoisted(() => vi.fn());

vi.mock("../src/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents.js")>();
  return {
    ...actual,
    listLiveAgents: vi.fn(async () => ({
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, orphans: [], report: null, mode: "full" },
    })),
  };
});

vi.mock("../src/vcs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vcs.js")>();
  return { ...actual, detectBackend: detect };
});

let db: Db | undefined;
beforeEach(() => {
  detect.mockReset();
  resetRecentCommitsBackendCacheForTests();
  db = openDb({ path: join(mkdtempSync(join(tmpdir(), "mu-recent-commits-")), "mu.db") });
});
afterEach(() => {
  db?.close();
  db = undefined;
});

const opts = { withRecentCommits: { limit: 3 } };

describe("loadWorkstreamSnapshotSlow recent-commits backend cache", () => {
  it("detects once and reuses the backend across ticks", async () => {
    const recentCommits = vi.fn(async () => [{ sha: "abc", subject: "s" }]);
    detect.mockResolvedValue({ name: "git", recentCommits });
    if (db === undefined) throw new Error("no db");

    const a = await loadWorkstreamSnapshotSlow(db, "ws", opts);
    const b = await loadWorkstreamSnapshotSlow(db, "ws", opts);

    expect(detect).toHaveBeenCalledTimes(1);
    expect(recentCommits).toHaveBeenCalledTimes(2);
    expect(a.commitsBackend).toBe("git");
    expect(b.recentCommits).toHaveLength(1);
  });

  it("does not cache `none`", async () => {
    detect.mockResolvedValue({ name: "none", recentCommits: vi.fn() });
    if (db === undefined) throw new Error("no db");

    const a = await loadWorkstreamSnapshotSlow(db, "ws", opts);
    await loadWorkstreamSnapshotSlow(db, "ws", opts);

    expect(a.commitsBackend).toBeNull();
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("skips detection entirely when commits are not requested", async () => {
    if (db === undefined) throw new Error("no db");
    await loadWorkstreamSnapshotSlow(db, "ws", {});
    expect(detect).not.toHaveBeenCalled();
  });
});
