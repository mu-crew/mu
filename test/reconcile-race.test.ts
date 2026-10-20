// Race: an agent is replaced under the same name while reconcile awaits
// the mux listing. The prune must not delete the new row.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, getAgent, insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { reconcile } from "../src/reconcile.js";
import { addTask, claimTask, getTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-reconcile-race-"));
  db = openDb({ path: join(tempDir, "mu.db") });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
});

describe("reconcile — same-name replacement race", () => {
  it("keeps the replacement agent and its claimed task", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1" });
    addTask(db, { localId: "t1", title: "t", impact: 50, effortDays: 1, workstream: "auth" });
    setTmuxExecutor(async (args) => {
      if (args[0] === "list-panes") {
        // During discovery: close alice (%1), respawn as %2, claim.
        deleteAgent(db, "alice", "auth");
        insertAgent(db, { name: "alice", workstream: "auth", paneId: "%2" });
        await claimTask(db, "t1", { agentName: "alice", workstream: "auth" });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    const report = await reconcile(db, { workstream: "auth" });

    expect(report.prunedGhosts).toBe(0);
    expect(getAgent(db, "alice", "auth")?.paneId).toBe("%2");
    expect(getTask(db, "t1", "auth")?.status).toBe("IN_PROGRESS");
  });
});
