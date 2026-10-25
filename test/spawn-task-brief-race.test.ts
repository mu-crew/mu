// Concurrent `spawn --task` of the SAME task: ONE reservation, ONE pane, ONE
// claim, ONE send and one brief. The strict per-attempt lock serialises the
// callers; the loser replays the winner's saved outcome. (Before the journal
// both callers spawned and sent different prompts to one task.)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { cmdSpawn } from "../src/cli/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";

const hits = vi.hoisted(() => ({ spawns: 0, sends: [] as string[] }));
vi.mock("../src/agents/spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/spawn.js")>();
  return {
    ...actual,
    spawnAgent: async (
      db: Db,
      opts: { name: string; workstream: string; onIdentity?: (a: unknown) => void },
    ) => {
      hits.spawns++;
      const row = insertAgent(db, {
        name: opts.name,
        workstream: opts.workstream,
        paneId: "%1",
      });
      opts.onIdentity?.(row);
      return { ...row, ctl: "ok", ctlSocket: "/fake.sock" };
    },
  };
});
vi.mock("../src/agents/transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/transport.js")>();
  return {
    ...actual,
    sendViaTransport: async (_a: unknown, text: string, o: { msgId?: string }) => {
      hits.sends.push(text);
      return { transport: "ctl", runs: 0, msgId: o.msgId, incarnation: "pi-inc" };
    },
  };
});

let dir: string;
let db: Db;
let mux: MuxHarness;

beforeEach(() => {
  hits.spawns = 0;
  hits.sends = [];
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

describe("spawn --task: concurrent callers of one attempt", () => {
  it("one spawn, one send, one brief; the second caller replays", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: unknown) => void logs.push(String(s)));
    await Promise.all([
      cmdSpawn(db, "worker-1", { workstream: "probe", task: "t1", send: "first", json: true }),
      cmdSpawn(db, "worker-1", { workstream: "probe", task: "t1", send: "first", json: true }),
    ]);
    expect(hits.spawns).toBe(1);
    expect(hits.sends).toEqual(["first"]);
    expect(db.prepare("SELECT content FROM task_notes WHERE kind = 'brief'").all()).toEqual([
      { content: "first" },
    ]);
    const replays = logs
      .map((l) => (JSON.parse(l) as { data: { task: { replay: boolean } } }).data.task.replay)
      .sort();
    expect(replays).toEqual([false, true]);
  });

  it("a second DIFFERENT prompt to the same attempt key is refused, not sent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await cmdSpawn(db, "worker-1", { workstream: "probe", task: "t1", send: "first", json: true });
    await expect(
      cmdSpawn(db, "worker-1", { workstream: "probe", task: "t1", send: "second", json: true }),
    ).rejects.toThrow(/different request/);
    expect(hits.sends).toEqual(["first"]);
  });
});
