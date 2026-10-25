// Concurrent `spawn --task` on an unbriefed task writes exactly one brief:
// the existence check and the INSERT are one transaction.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdSpawn } from "../src/cli/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";

vi.mock("../src/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents.js")>();
  return {
    ...actual,
    spawnAgent: async (db: Db, opts: { name: string; workstream: string }) => ({
      ...actual.insertAgent(db, { name: opts.name, workstream: opts.workstream, paneId: "%1" }),
      ctl: "ok",
      ctlSocket: "/fake.sock",
    }),
    sendToAgent: async () => ({
      transport: "ctl",
      runs: 0,
      msgId: "receipt",
      incarnation: "pi-inc",
      sentBytes: 1,
      delivered: true,
    }),
  };
});

let dir: string;
let db: Db;
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mubr-"));
  db = openDb({ path: join(dir, "mu.db") });
  mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  ensureWorkstream(db, "probe");
  addTask(db, { localId: "t1", workstream: "probe", title: "T", impact: 50, effortDays: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
  mux.restore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("spawn --task: concurrent briefs", () => {
  it("two concurrent spawns write one brief; the loser reports kept", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: unknown) => void logs.push(String(s)));
    await Promise.all([
      cmdSpawn(db, "worker-1", { workstream: "probe", task: "t1", send: "first", json: true }),
      cmdSpawn(db, "worker-2", { workstream: "probe", task: "t1", send: "second", json: true }),
    ]);
    const briefs = db.prepare("SELECT kind, content FROM task_notes WHERE kind = 'brief'").all();
    expect(briefs).toHaveLength(1);
    const states = logs
      .map((l) => (JSON.parse(l) as { data: { task: { brief: string } } }).data.task.brief)
      .sort();
    expect(states).toEqual(["kept", "recorded"]);
  });
});
