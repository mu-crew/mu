// The two identity CASes spawn --task's rollback relies on (v_spawn_receipts):
//   claimTask(expectedAgentId): a name that was deleted and recreated between
//     the caller's check and the claim must NOT hand the task to the replacement.
//   releaseTask(expectedOwnerId): a rollback releases only a task that is still
//     owned by the agent it created.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { claimTask, releaseTask } from "../src/tasks/claim.js";
import { addTask } from "../src/tasks/edit.js";
import { ClaimerNotRegisteredError } from "../src/tasks/errors.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { getTask } from "../src/tasks/queries.js";
import { ensureWorkstream } from "../src/workstream.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mce-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "auth");
  addTask(db, { localId: "t1", workstream: "auth", title: "T", impact: 50, effortDays: 1 });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const agent = (name = "worker-1", pane = "%1") =>
  insertAgent(db, { name, workstream: "auth", paneId: pane });

describe("claimTask expectedAgentId", () => {
  it("a deleted and recreated name: the REPLACEMENT does not get the task (the /tmp repro)", async () => {
    const original = agent();
    deleteAgent(db, "worker-1", "auth");
    const replacement = agent("worker-1", "%2");
    expect(replacement.incarnation).not.toBe(original.incarnation);
    await expect(
      claimTask(db, "t1", {
        workstream: "auth",
        agentName: "worker-1",
        expectedAgentId: original.incarnation,
      }),
    ).rejects.toBeInstanceOf(ClaimerNotRegisteredError);
    expect(getTask(db, "t1", "auth")).toMatchObject({ ownerId: null, status: "OPEN" });
  });

  it("without expectedAgentId the name still resolves to whoever holds it (unchanged default)", async () => {
    agent();
    deleteAgent(db, "worker-1", "auth");
    const replacement = agent("worker-1", "%2");
    await claimTask(db, "t1", { workstream: "auth", agentName: "worker-1" });
    expect(getTask(db, "t1", "auth")?.ownerId).toBe(replacement.incarnation);
  });

  it("the matching incarnation claims normally", async () => {
    const a = agent();
    await claimTask(db, "t1", {
      workstream: "auth",
      agentName: "worker-1",
      expectedAgentId: a.incarnation,
    });
    expect(getTask(db, "t1", "auth")).toMatchObject({
      ownerId: a.incarnation,
      status: "IN_PROGRESS",
    });
  });
});

describe("releaseTask expectedOwnerId", () => {
  it("releases a task still owned by that agent", async () => {
    const a = agent();
    await claimTask(db, "t1", { workstream: "auth", agentName: "worker-1" });
    const r = releaseTask(db, "t1", { workstream: "auth", expectedOwnerId: a.incarnation });
    expect(r.changed).toBe(true);
    expect(getTask(db, "t1", "auth")).toMatchObject({ ownerId: null, status: "OPEN" });
  });

  it("leaves a task another agent owns now", async () => {
    const a = agent();
    const b = agent("worker-2", "%2");
    await claimTask(db, "t1", { workstream: "auth", agentName: "worker-2" });
    const r = releaseTask(db, "t1", { workstream: "auth", expectedOwnerId: a.incarnation });
    expect(r.changed).toBe(false);
    expect(getTask(db, "t1", "auth")).toMatchObject({
      ownerId: b.incarnation,
      status: "IN_PROGRESS",
    });
  });

  it("leaves a task that was closed meanwhile (still owned by the agent)", async () => {
    const a = agent();
    await claimTask(db, "t1", { workstream: "auth", agentName: "worker-1" });
    closeTask(db, "t1", { workstream: "auth", evidence: "done" });
    const r = releaseTask(db, "t1", { workstream: "auth", expectedOwnerId: a.incarnation });
    expect(r.changed).toBe(false);
    expect(getTask(db, "t1", "auth")?.status).toBe("CLOSED");
  });

  it("an unowned task stays unowned (no-op)", () => {
    const a = agent();
    const r = releaseTask(db, "t1", { workstream: "auth", expectedOwnerId: a.incarnation });
    expect(r.changed).toBe(false);
  });
});
