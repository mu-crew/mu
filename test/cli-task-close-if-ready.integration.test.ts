// CLI tests for `mu task close --if-ready` (fb_umbrella_no_auto_close).
//
// The dogfood report: built a wave umbrella with 18 blockers; after
// every blocker reached CLOSED, the umbrella stayed OPEN (had to
// remember to close manually). `--if-ready` is the cheap fix: bare
// `mu task close` is unchanged, `--if-ready` no-ops unless every
// direct blocker is CLOSED and lists the still-blocking ids when it
// skips.
//
// We exercise the wired CLI via runCli (real SQLite + buildProgram)
// so the assertions cover the JSON shape the orchestrator depends on
// + the human card the operator sees.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask, closeTask, getTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliJson } from "./_runCli.js";

describe("mu task close --if-ready", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-close-if-ready-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("closes a task with zero blockers", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
    });
    seed.close();

    const r = await runCliJson(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--evidence", "test", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const payload = r.data as {
      changed: boolean;
      status: string;
      skipped?: string;
    };
    expect(payload.changed).toBe(true);
    expect(payload.status).toBe("CLOSED");
    expect(payload.skipped).toBeUndefined();

    const check = openDb({ path: dbPath });
    expect(getTask(check, "umbrella", "test")?.status).toBe("CLOSED");
    check.close();
  });

  it("closes when every blocker is CLOSED", async () => {
    const seed = openDb({ path: dbPath });
    for (const id of ["a", "b", "c"]) {
      addTask(seed, {
        localId: id,
        workstream: "test",
        title: id.toUpperCase(),
        impact: 50,
        effortDays: 1,
      });
    }
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a", "b", "c"],
    });
    closeTask(seed, "a", { workstream: "test", evidence: "test" });
    closeTask(seed, "b", { workstream: "test", evidence: "test" });
    closeTask(seed, "c", { workstream: "test", evidence: "test" });
    seed.close();

    const r = await runCliJson(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--evidence", "test", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const payload = r.data as { changed: boolean; status: string; skipped?: string };
    expect(payload.changed).toBe(true);
    expect(payload.status).toBe("CLOSED");
    expect(payload.skipped).toBeUndefined();

    const check = openDb({ path: dbPath });
    expect(getTask(check, "umbrella", "test")?.status).toBe("CLOSED");
    check.close();
  });

  it("no-ops + lists still-blocking ids when any blocker is OPEN/IN_PROGRESS", async () => {
    const seed = openDb({ path: dbPath });
    for (const id of ["a", "b", "c"]) {
      addTask(seed, {
        localId: id,
        workstream: "test",
        title: id.toUpperCase(),
        impact: 50,
        effortDays: 1,
      });
    }
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a", "b", "c"],
    });
    // a CLOSED, b/c still OPEN.
    closeTask(seed, "a", { workstream: "test", evidence: "test" });
    seed.close();

    const r = await runCliJson(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--evidence", "test", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const payload = r.data as {
      taskName: string;
      changed: boolean;
      skipped?: string;
      previousStatus: string;
      status: string;
      blockingIds?: string[];
      nextSteps: { intent: string; command: string }[];
    };
    expect(payload.changed).toBe(false);
    expect(payload.skipped).toBe("not_ready");
    expect(payload.previousStatus).toBe("OPEN");
    expect(payload.status).toBe("OPEN");
    expect(payload.blockingIds).toEqual(["b", "c"]);
    // Next: hint watches the still-blocking set and exits when a worker needs attention.
    expect(payload.nextSteps.map((s) => s.command)).toContain(
      "mu task wait b c -w test --first --any --on-stall exit",
    );

    const check = openDb({ path: dbPath });
    expect(getTask(check, "umbrella", "test")?.status).toBe("OPEN");
    check.close();
  });

  it("bare `mu task close --as done` refuses while a blocker is open (exit 4, names it)", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    seed.close();

    const r = await runCliJson(
      ["task", "close", "umbrella", "-w", "test", "--evidence", "test", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBe(4);
    expect(String(r.doc.message)).toContain("open blockers: a");
    expect(JSON.stringify(r.doc)).toContain("mu task tree umbrella -w test");
  });

  it("a non-done close still closes over open blockers (it claims no work happened)", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    seed.close();

    const r = await runCliJson(
      ["task", "close", "umbrella", "-w", "test", "--as", "wontfix", "--why", "dropped", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ changed: true, status: "CLOSED" });
  });

  it("--if-ready without --evidence and no open blockers: usage refusal (exit 2, one line), nothing written", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "U",
      impact: 50,
      effortDays: 1,
    });
    seed.close();

    const r = await runCli(["task", "close", "umbrella", "-w", "test", "--if-ready"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--evidence");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("human card prints the skip reason + still-blocking ids", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, {
      localId: "a",
      workstream: "test",
      title: "A",
      impact: 50,
      effortDays: 1,
    });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    seed.close();

    const r = await runCli(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--evidence", "test"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("Skipped");
    expect(r.stdout).toContain("umbrella");
    expect(r.stdout).toContain("blocked by 1 task");
    expect(r.stdout).toContain("a");
    expect(r.stdout).toContain("mu task wait a");
    expect(r.stdout).toContain("--on-stall exit");
  });
});
