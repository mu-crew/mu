import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeAgentIdle, insertAgent, type LiveAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask, setTaskStatus } from "../src/tasks.js";

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-agent-idle-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  const key = "MU_IDLE_THRESHOLD_MS";
  delete process.env[key];
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  const key = "MU_IDLE_THRESHOLD_MS";
  delete process.env[key];
});

function live(state: LiveAgent["state"], since: string | null): LiveAgent {
  const agent = insertAgent(db, { name: "worker-1", workstream: "ws", paneId: "%1" });
  return { ...agent, state, source: state === "unknown" ? "none" : "murmur", since };
}

function giveTask(): void {
  addTask(db, { localId: "t1", workstream: "ws", title: "T1", impact: 1, effortDays: 1 });
  setTaskStatus(db, "t1", "IN_PROGRESS", { workstream: "ws" });
  db.prepare(
    "UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'worker-1') WHERE local_id = 't1'",
  ).run();
}

describe("computeAgentIdle", () => {
  it("uses the runtime state's since time for an assigned agent", () => {
    const agent = live("needs_input", new Date(0).toISOString());
    giveTask();
    expect(computeAgentIdle(db, agent, 600_000)).toBe(true);
  });

  it("requires an in-progress task owned by the agent", () => {
    expect(computeAgentIdle(db, live("needs_input", new Date(0).toISOString()), 600_000)).toBe(
      false,
    );
  });

  it("does not mark an unknown state idle", () => {
    const agent = live("unknown", new Date(0).toISOString());
    giveTask();
    expect(computeAgentIdle(db, agent, 600_000)).toBe(false);
  });

  it("does not mark a state with no since time idle", () => {
    const agent = live("needs_input", null);
    giveTask();
    expect(computeAgentIdle(db, agent, 600_000)).toBe(false);
  });
});
