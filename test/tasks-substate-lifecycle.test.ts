// Substate lifecycle verbs: close --as/--why, park, unpark, the
// parked-claim guard, and the unblocked-dependents report
// (docs/specs/2026-09-29-task-substates.md § CLI and SDK surface).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  addTask,
  type CloseTaskOptions,
  claimTask,
  closeTask,
  getTask,
  InvalidSubstateError,
  listGoals,
  listNotes,
  listReady,
  openTask,
  parkTask,
  releaseTask,
  SubstateReasonRequiredError,
  TaskParkedError,
  TaskParkStateError,
  unparkTask,
} from "../src/tasks.js";

const WS = "ws";
let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-substate-lifecycle-"));
  db = openDb({ path: join(tempDir, "mu.db") });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function add(localId: string, blockedBy?: string[]): void {
  addTask(db, {
    localId,
    workstream: WS,
    title: localId,
    impact: 50,
    effortDays: 1,
    ...(blockedBy ? { blockedBy } : {}),
  });
}

function pair(localId: string): string {
  const t = getTask(db, localId, WS);
  if (!t) throw new Error(`missing ${localId}`);
  return `${t.status}/${t.substate}`;
}

function opCount(): number {
  return (db.prepare("SELECT count(*) AS n FROM ops").get() as { n: number }).n;
}

function noteContents(localId: string): string[] {
  return listNotes(db, localId, WS).map((n) => n.content);
}

function readyNames(): string[] {
  return listReady(db, WS).map((t) => t.name);
}

describe("closeTask --as / --why", () => {
  it("defaults to CLOSED/done and reports no unblocked dependents", () => {
    add("a");
    add("b", ["a"]);
    const r = closeTask(db, "a", { workstream: WS });
    expect(pair("a")).toBe("CLOSED/done");
    if ("skipped" in r) throw new Error("unexpected skip");
    expect(r.substate).toBe("done");
    expect(r.unblocked).toEqual([]);
  });

  it("refuses a non-done close without a reason, before any write", () => {
    add("a");
    const before = opCount();
    expect(() => closeTask(db, "a", { workstream: WS, as: "wontfix" })).toThrow(
      SubstateReasonRequiredError,
    );
    expect(() => closeTask(db, "a", { workstream: WS, as: "wontfix", why: "  " })).toThrow(
      SubstateReasonRequiredError,
    );
    expect(pair("a")).toBe("OPEN/todo");
    expect(opCount()).toBe(before);
  });

  it("closes as wontfix, stores the reason, and reports the unblocked dependent", () => {
    add("a");
    add("b", ["a"]);
    add("c", ["a", "b"]); // still blocked by b afterwards
    expect(readyNames()).toEqual(["a"]);
    const r = closeTask(db, "a", { workstream: WS, as: "wontfix", why: "out of scope" });
    if ("skipped" in r) throw new Error("unexpected skip");
    expect(pair("a")).toBe("CLOSED/wontfix");
    expect(r.previousSubstate).toBe("todo");
    expect(r.unblocked).toEqual(["b"]);
    expect(noteContents("a")).toContain("WONTFIX: out of scope");
    expect(readyNames()).toContain("b");
  });

  it("writes status and substate in one task op, grouped with the reason note", () => {
    add("a");
    closeTask(db, "a", { workstream: WS, as: "duplicate", why: "see b" });
    const ops = db
      .prepare("SELECT entity, group_id, payload FROM ops WHERE intent = 'task.close'")
      .all() as { entity: string; group_id: string; payload: string }[];
    // Exactly one task op carries the pair. The note's touchTask may add a
    // second, updated_at-only task op when the clock ticks between the
    // two writes (timing-dependent), so filter on the pair fields.
    const taskOps = ops.filter(
      (o) => o.entity === "task" && "status" in (JSON.parse(o.payload) as object),
    );
    expect(taskOps).toHaveLength(1);
    expect(new Set(ops.map((o) => o.group_id)).size).toBe(1);
    const payload = JSON.parse(taskOps[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(payload.status).toBe("CLOSED");
    expect(payload.substate).toBe("duplicate");
    const note = ops.find((o) => o.entity === "note");
    expect(note?.group_id).toBe(taskOps[0]?.group_id);
  });

  it("rejects a substate that does not belong to CLOSED", () => {
    add("a");
    const opts = { workstream: WS, as: "parked", why: "x" } as unknown as CloseTaskOptions;
    expect(() => closeTask(db, "a", opts)).toThrow(InvalidSubstateError);
    expect(pair("a")).toBe("OPEN/todo");
  });

  it("re-closing with a different --as changes the substate; the same --as is a no-op", () => {
    add("a");
    closeTask(db, "a", { workstream: WS });
    const r = closeTask(db, "a", { workstream: WS, as: "superseded", why: "by b" });
    if ("skipped" in r) throw new Error("unexpected skip");
    expect(r.changed).toBe(true);
    expect(pair("a")).toBe("CLOSED/superseded");
    const again = closeTask(db, "a", { workstream: WS, as: "superseded", why: "by b" });
    expect(again.changed).toBe(false);
    expect(noteContents("a").filter((c) => c.startsWith("SUPERSEDED:"))).toHaveLength(1);
  });

  it("--if-ready fires when the only blocker is CLOSED/duplicate", () => {
    add("x");
    add("umbrella", ["x"]);
    closeTask(db, "x", { workstream: WS, as: "duplicate", why: "dup" });
    const r = closeTask(db, "umbrella", { workstream: WS, ifReady: true });
    expect("skipped" in r).toBe(false);
    expect(pair("umbrella")).toBe("CLOSED/done");
  });
});

describe("parkTask / unparkTask", () => {
  it("parks an OPEN task: out of ready, still a goal, one task op", () => {
    add("a");
    const r = parkTask(db, "a", { workstream: WS, why: "later" });
    expect(r.changed).toBe(true);
    expect(pair("a")).toBe("OPEN/parked");
    expect(readyNames()).not.toContain("a");
    expect(listGoals(db, WS).map((t) => t.name)).toContain("a");
    expect(noteContents("a")).toContain("PARKED: later");
    const n = db
      .prepare(
        "SELECT count(*) AS n FROM ops WHERE entity = 'task' AND key = ? AND intent = 'task.park'",
      )
      .get(`${WS}/a`) as { n: number };
    expect(n.n).toBe(1);
  });

  it("is idempotent on OPEN/parked (no second note)", () => {
    add("a");
    parkTask(db, "a", { workstream: WS, why: "later" });
    const r = parkTask(db, "a", { workstream: WS, why: "again" });
    expect(r.changed).toBe(false);
    expect(noteContents("a")).toEqual(["PARKED: later"]);
  });

  it("requires a reason", () => {
    add("a");
    expect(() => parkTask(db, "a", { workstream: WS, why: "" })).toThrow(
      SubstateReasonRequiredError,
    );
    expect(pair("a")).toBe("OPEN/todo");
  });

  it("refuses IN_PROGRESS with a release next step", async () => {
    add("a");
    await claimTask(db, "a", { workstream: WS, self: true, actor: "me" });
    let err: unknown;
    try {
      parkTask(db, "a", { workstream: WS, why: "later" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaskParkStateError);
    expect((err as TaskParkStateError).errorNextSteps()[0]?.command).toContain("mu task release");
  });

  it("refuses CLOSED with an open next step", () => {
    add("a");
    closeTask(db, "a", { workstream: WS });
    let err: unknown;
    try {
      parkTask(db, "a", { workstream: WS, why: "later" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaskParkStateError);
    expect((err as TaskParkStateError).errorNextSteps()[0]?.command).toContain("mu task open");
  });

  it("unpark returns OPEN/todo; a no-op on other pairs", () => {
    add("a");
    add("b");
    parkTask(db, "a", { workstream: WS, why: "later" });
    expect(unparkTask(db, "a", { workstream: WS }).changed).toBe(true);
    expect(pair("a")).toBe("OPEN/todo");
    expect(readyNames()).toContain("a");
    expect(unparkTask(db, "b", { workstream: WS }).changed).toBe(false);
  });

  it("open and release --reopen both land on OPEN/todo", () => {
    add("a");
    add("b");
    parkTask(db, "a", { workstream: WS, why: "later" });
    openTask(db, "a", { workstream: WS });
    expect(pair("a")).toBe("OPEN/todo");
    closeTask(db, "b", { workstream: WS, as: "wontfix", why: "no" });
    releaseTask(db, "b", { workstream: WS, reopen: true });
    expect(pair("b")).toBe("OPEN/todo");
  });
});

describe("claim on a parked task", () => {
  it("refuses a self-claim without force; force claims it", async () => {
    add("a");
    parkTask(db, "a", { workstream: WS, why: "later" });
    await expect(claimTask(db, "a", { workstream: WS, self: true, actor: "me" })).rejects.toThrow(
      TaskParkedError,
    );
    expect(pair("a")).toBe("OPEN/parked");
    await claimTask(db, "a", { workstream: WS, self: true, actor: "me", force: true });
    expect(pair("a")).toBe("IN_PROGRESS/active");
  });

  it("refuses a worker claim without force, with unpark / --force next steps", async () => {
    add("a");
    insertAgent(db, { name: "alice", workstream: WS, paneId: "%1" });
    parkTask(db, "a", { workstream: WS, why: "later" });
    let err: unknown;
    try {
      await claimTask(db, "a", { workstream: WS, agentName: "alice" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaskParkedError);
    const cmds = (err as TaskParkedError).errorNextSteps().map((s) => s.command);
    expect(cmds[0]).toContain("mu task unpark a");
    expect(cmds[1]).toContain("--force");
    expect(getTask(db, "a", WS)?.ownerName).toBeNull();
    await claimTask(db, "a", { workstream: WS, agentName: "alice", force: true });
    expect(pair("a")).toBe("IN_PROGRESS/active");
  });
});
