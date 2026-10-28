// A pi pane spawned for a kind=delegate task keeps its pi session under
// <DB dir>/delegate-sessions/<ws>/<task> (PI_CODING_AGENT_SESSION_DIR), out of the
// caller's /resume list; any other task, or a non-pi agent, gets nothing.
// The transport is substituted (no pi answers here); the spawn, the task
// lookup and the pane env reach the mocked tmux for real.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agents/transport.js", async (orig) => {
  const real = await orig<typeof import("../src/agents/transport.js")>();
  return { ...real, sendViaTransport: async () => ({ transport: "mux" }) };
});

import {
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnForTask,
} from "../src/agents.js";
import type { TaskKind } from "../src/db.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let db: Db;
let mux: MuxHarness;
let calls: string[][];
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mds-"));
  db = openDb({ path: join(dir, "mu.db") });
  saved = process.env.MU_SPAWN_LIVENESS_MS;
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  ensureWorkstream(db, "auth");
  const m = mockTmux(freshMockState());
  calls = m.calls;
  mux = installMux("tmux", m.executor);
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

/** Spawn `cli` for a fresh task of `kind`; the pane's PI_CODING_AGENT_SESSION_DIR values. */
async function spawnFor(kind: TaskKind, cli: string): Promise<string[]> {
  addTask(db, { localId: "t1", workstream: "auth", title: "T", impact: 50, effortDays: 1, kind });
  await spawnForTask(db, {
    task: "t1",
    text: "check it",
    spawn: { name: "a-1", workstream: "auth", cli, ctl: false },
  });
  return calls.flat().filter((a) => a.startsWith("PI_CODING_AGENT_SESSION_DIR="));
}

describe("delegate session dir", () => {
  it("a delegate's pi pane keeps its session under the DB dir, one folder per call task", async () => {
    expect(await spawnFor("delegate", "pi")).toEqual([
      `PI_CODING_AGENT_SESSION_DIR=${join(dir, "delegate-sessions", "auth", "t1")}`,
    ]);
  });

  it("a work task's pi pane keeps pi's default", async () => {
    expect(await spawnFor("work", "pi")).toEqual([]);
  });

  it("a delegate on a non-pi cli gets no pi env", async () => {
    expect(await spawnFor("delegate", "claude")).toEqual([]);
  });
});
