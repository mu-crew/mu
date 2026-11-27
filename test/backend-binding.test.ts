// Spec A §8.2: one managed backend per workstream. A spawn refuses while a live row
// names another backend; reconcile keeps that row; a Rex terminal driving tmux is allowed.
// herdr is retired (mu 6), but its `w1:p1` rows stay recognised as foreign: no backend
// lists their panes, so reconcile must never reap them as ghosts.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MuxBackendMismatchError } from "../src/agents/errors.js";
import { getAgent, insertAgent, spawnAgent, spawnForTask } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { foreignBackend, paneBackend } from "../src/mux/binding.js";
import { reconcile } from "../src/reconcile.js";
import { addTask, claimTask, getTask } from "../src/tasks.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";

const REX = "block:12345678-1234-1234-1234-123456789abc";
const HERDR = "w1:p2";

let tempDir: string;
let db: Db;
let mux: MuxHarness | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-backend-binding-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  process.env.MU_SPAWN_LIVENESS_MS = "0";
});

afterEach(() => {
  mux?.restore();
  mux = undefined;
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  const key = "MU_SPAWN_LIVENESS_MS";
  delete process.env[key];
});

const none = async () => ({ stdout: "", stderr: "", exitCode: 1 });

describe("pane id shape names the backend", () => {
  it("keeps herdr ids recognised as the retired herdr, foreign to every live backend", () => {
    for (const id of ["w1:p1", "wA:pZ", "w10:p1A"]) {
      expect(paneBackend(id)).toBe("herdr");
      expect(foreignBackend(id, "tmux")).toBe("herdr");
      expect(foreignBackend(id, "rex")).toBe("herdr");
    }
  });

  it("names the live backends, and nothing for other shapes", () => {
    expect(paneBackend("%1")).toBe("tmux");
    expect(paneBackend(REX)).toBe("rex");
    expect(foreignBackend("%1", "tmux")).toBeUndefined();
    for (const id of ["w1:t1", "w1", "w1:p", "%pending-x", ""])
      expect(paneBackend(id)).toBeUndefined();
  });
});

describe("spawn refusal across backends", () => {
  it.each([
    ["tmux", REX, "rex"],
    ["rex", "%1", "tmux"],
  ] as const)("%s refuses a workstream with a %s-shaped row", async (active, paneId, other) => {
    insertAgent(db, { name: "old", workstream: "auth", paneId });
    mux = installMux(active, none);
    const err = await spawnAgent(db, { name: "new", workstream: "auth" }).catch((e) => e);
    expect(err).toBeInstanceOf(MuxBackendMismatchError);
    expect(err.message).toContain(`on ${other}`);
    expect(err.message).toContain(`MU_MUX=${other}`);
    expect(getAgent(db, "new", "auth")).toBeUndefined();
  });

  it.each(["tmux", "rex"] as const)(
    "%s refuses a workstream with a retired herdr row, never offering MU_MUX=herdr",
    async (active) => {
      insertAgent(db, { name: "old", workstream: "auth", paneId: HERDR });
      mux = installMux(active, none);
      const err = await spawnAgent(db, { name: "new", workstream: "auth" }).catch((e) => e);
      expect(err).toBeInstanceOf(MuxBackendMismatchError);
      expect(err.message).toContain("on herdr");
      expect(err.message).toContain("no longer drives herdr");
      expect(err.message).not.toContain("MU_MUX=herdr");
      expect(err.message).toContain(`new workstream on ${active}`);
      expect(getAgent(db, "new", "auth")).toBeUndefined();
    },
  );

  it("refuses before reclaiming a dead local staging and its tree", async () => {
    const cwd = join(tempDir, "stage");
    mkdirSync(cwd);
    insertAgent(db, { name: "stage", workstream: "auth", paneId: "%pending-stage", cwd });
    db.prepare("UPDATE agents SET updated_at = ? WHERE name = ?").run(
      "2000-01-01T00:00:00Z",
      "stage",
    );
    const before = getAgent(db, "stage", "auth");
    insertAgent(db, { name: "old", workstream: "auth", paneId: REX });
    mux = installMux("tmux", none);

    await expect(spawnAgent(db, { name: "new", workstream: "auth" })).rejects.toBeInstanceOf(
      MuxBackendMismatchError,
    );
    expect({ staging: getAgent(db, "stage", "auth"), treeExists: existsSync(cwd) }).toEqual({
      staging: before,
      treeExists: true,
    });
  });

  it("does not journal or claim a refused task spawn", async () => {
    insertAgent(db, { name: "old", workstream: "auth", paneId: REX });
    addTask(db, { localId: "job", workstream: "auth", title: "Job" });
    mux = installMux("tmux", none);

    await expect(
      spawnForTask(db, {
        spawn: { name: "new", workstream: "auth" },
        task: "job",
        text: "Do the job",
      }),
    ).rejects.toBeInstanceOf(MuxBackendMismatchError);
    expect(db.prepare("SELECT name, state FROM spawn_receipts").all()).toEqual([]);
    expect(getTask(db, "job", "auth")).toMatchObject({ status: "OPEN", ownerId: null });
    expect(getAgent(db, "new", "auth")).toBeUndefined();
  });

  it("offers a new workstream instead of a close under the wrong backend", async () => {
    insertAgent(db, { name: "old", workstream: "auth", paneId: REX });
    mux = installMux("tmux", none);
    const err = await spawnAgent(db, { name: "new", workstream: "auth" }).catch((e) => e);
    expect(err).toBeInstanceOf(MuxBackendMismatchError);
    expect(err.message).not.toContain("mu agent close");
    expect(err.message).toContain("new workstream");
  });

  it("does not refuse across workstreams", async () => {
    insertAgent(db, { name: "old", workstream: "other", paneId: HERDR });
    mux = installMux("tmux", none);
    const err = await spawnAgent(db, { name: "new", workstream: "auth" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(MuxBackendMismatchError);
  });

  it("allows a Rex terminal with tmux workers: only rows count", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    mux = installMux("tmux", none);
    const err = await spawnAgent(db, { name: "w2", workstream: "auth" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(MuxBackendMismatchError);
  });
});

describe("reconcile keeps other backends' rows", () => {
  it("reports a foreign pane as unknown in mu state, keeping its row and ownership", async () => {
    const old = insertAgent(db, { name: "old", workstream: "auth", paneId: REX, channel: "mux" });
    addTask(db, { localId: "job", workstream: "auth", title: "Job" });
    await claimTask(db, "job", { workstream: "auth", agentName: "old" });
    mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    const { exitCode, data } = await runCliJson(["state", "-w", "auth", "--full"], db.name);
    expect(exitCode).toBeNull();
    expect(getAgent(db, "old", "auth")).toEqual(old);
    expect(getTask(db, "job", "auth")).toMatchObject({
      status: "IN_PROGRESS",
      ownerId: old.incarnation,
    });
    expect(data.workstreams[0].agents).toMatchObject([
      {
        name: "old",
        pane_id: REX,
        state: "unknown",
        reason: "foreign backend: rex (active: tmux)",
      },
    ]);
  });

  it.each(["tmux", "rex"] as const)(
    "%s never reaps a retired herdr row in full mode: row, ownership and task kept",
    async (active) => {
      const old = insertAgent(db, { name: "h", workstream: "auth", paneId: HERDR });
      addTask(db, { localId: "job", workstream: "auth", title: "Job" });
      await claimTask(db, "job", { workstream: "auth", agentName: "h" });
      const stdout = active === "rex" ? JSON.stringify({ sessions: [] }) : "";
      mux = installMux(active, async () => ({ stdout, stderr: "", exitCode: 0 }));
      const report = await reconcile(db, { workstream: "auth", mode: "full" });
      expect(report.prunedGhosts).toBe(0);
      expect(report.foreign.map((a) => a.name)).toEqual(["h"]);
      expect(getAgent(db, "h", "auth")).toEqual(old);
      expect(getTask(db, "job", "auth")).toMatchObject({
        status: "IN_PROGRESS",
        ownerId: old.incarnation,
      });
    },
  );

  it("reports a retired herdr row as unknown in mu state, never reaping it", async () => {
    const old = insertAgent(db, { name: "h", workstream: "auth", paneId: "wA:pZ" });
    mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const { exitCode, data } = await runCliJson(["state", "-w", "auth", "--full"], db.name);
    expect(exitCode).toBeNull();
    expect(getAgent(db, "h", "auth")).toEqual(old);
    expect(data.workstreams[0].agents).toMatchObject([
      { name: "h", state: "unknown", reason: "foreign backend: herdr (active: tmux)" },
    ]);
  });

  it("prunes only the active backend's ghost", async () => {
    insertAgent(db, { name: "t", workstream: "auth", paneId: "%1" });
    insertAgent(db, { name: "h", workstream: "auth", paneId: HERDR });
    insertAgent(db, { name: "r", workstream: "auth", paneId: REX });
    mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.prunedGhosts).toBe(1);
    expect(report.foreign.map((a) => a.name).sort()).toEqual(["h", "r"]);
    expect(getAgent(db, "t", "auth")).toBeUndefined();
    expect(getAgent(db, "h", "auth")).toBeDefined();
    expect(getAgent(db, "r", "auth")).toBeDefined();
  });
});
