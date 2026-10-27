// t_surface round 1: the cold-guess and matrix misses that became aliases or a default.
// `agent stop` = `agent close`; a plural
// noun names its list verb; the blockers view carries the task's local id.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetCommandResolverForTests, setCommandResolverForTests } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let path: string;
let db: Db;
let mux: MuxHarness;
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "msa-"));
  path = join(dir, "mu.db");
  db = openDb({ path });
  saved = process.env.MU_SPAWN_LIVENESS_MS;
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  ensureWorkstream(db, "auth");
  for (const id of ["t1", "t2"]) {
    addTask(db, { localId: id, workstream: "auth", title: id, impact: 50, effortDays: 1 });
  }
  mux = installMux("tmux", mockTmux(freshMockState()).executor);
});

afterEach(() => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.MU_SPAWN_LIVENESS_MS;
  else process.env.MU_SPAWN_LIVENESS_MS = saved;
});

const strip = (s: string) =>
  s.replace(new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, "g"), "");

describe("t_surface round 1", () => {
  it("agent stop is agent close", async () => {
    const r = await runCli(["agent", "stop", "--help"], path);
    expect(strip(r.stdout)).toContain("Usage: mu agent close|stop");
  });

  it.each([
    [["tasks"], "unknown command 'tasks' (closest: mu task list); see mu --help"],
    [["show"], "unknown command 'show' (closest: mu task show); see mu --help"],
    [["agents"], "unknown command 'agents' (closest: mu agent list); see mu --help"],
  ])("did-you-mean %j", async (argv, line) => {
    const r = await runCli(argv, path);
    expect(strip(r.stderr).trim()).toBe(`error: ${line}`);
  });

  it("the blockers view names the task by local id", () => {
    addTask(db, { localId: "t3", workstream: "auth", title: "t3", impact: 50, effortDays: 1 });
    db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) SELECT a.id, b.id, '2026-01-01T00:00:00Z' FROM tasks a, tasks b WHERE a.local_id = 't1' AND b.local_id = 't3'",
    ).run();
    expect(
      db.prepare("SELECT task_local_id AS t, blocker_local_id AS b FROM blockers").all(),
    ).toEqual([{ t: "t3", b: "t1" }]);
  });
});
