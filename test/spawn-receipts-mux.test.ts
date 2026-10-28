// spawn --task with a non-pi agent on a mux that CAN send (herdr's
// `agent prompt`): the delivery carries no receipt id. The transport is
// substituted (the frozen backend objects cannot be patched); the journal,
// claim and replay around it are the real ones.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  texts: [] as string[],
  mode: "ok" as "ok" | "undelivered" | "throws",
}));
vi.mock("../src/agents/transport.js", async (orig) => {
  const real = await orig<typeof import("../src/agents/transport.js")>();
  return {
    ...real,
    sendViaTransport: async (
      _agent: unknown,
      text: string,
      o: { onUndelivered?: (w: unknown) => void },
    ) => {
      hook.texts.push(text);
      if (hook.mode === "throws") throw new Error("herdr: agent prompt failed");
      if (hook.mode === "undelivered") {
        o.onUndelivered?.({ paneId: "%1", reason: "paste-vanished", message: "never registered" });
      }
      return { transport: "mux" };
    },
  };
});

import { getReceipt } from "../src/agents/receipts.js";
import {
  getAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnForTask,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask, selectTaskNotes, taskIdFor } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let db: Db;
let mux: MuxHarness;
let saved: string | undefined;

beforeEach(() => {
  hook.texts = [];
  hook.mode = "ok";
  dir = mkdtempSync(join(tmpdir(), "msm-"));
  db = openDb({ path: join(dir, "mu.db") });
  saved = process.env.MU_SPAWN_LIVENESS_MS;
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  ensureWorkstream(db, "auth");
  addTask(db, { localId: "t1", workstream: "auth", title: "T", impact: 50, effortDays: 1 });
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

const req = () => ({
  task: "t1",
  text: "do the thing",
  spawn: { name: "worker-1", workstream: "auth", cli: "claude" },
});
const receipt = () => getReceipt(db, taskIdFor(db, "t1", "auth") ?? 0, "manual:t1");
const brief = () =>
  selectTaskNotes(db, "t1", { workstream: "auth" }).notes.filter((n) => n.kind === "brief");

describe("non-pi delivery (no receipt id)", () => {
  it("a confirmed paste: sent over the mux, claimed, brief pinned", async () => {
    const out = await spawnForTask(db, req());
    expect(out).toMatchObject({ state: "sent", brief: "recorded" });
    expect(receipt()).toMatchObject({ state: "sent", transport: "mux" });
    expect(getTask(db, "t1", "auth")?.ownerId).toBe(getAgent(db, "worker-1", "auth")?.incarnation);
    expect(hook.texts).toEqual(["do the thing"]);
  });

  it("an unconfirmed paste is UNKNOWN: pane and claim kept, no brief; the replay cannot ask and never re-pastes", async () => {
    hook.mode = "undelivered";
    const out = await spawnForTask(db, req());
    expect(out).toMatchObject({ state: "unknown", brief: "pending" });
    expect(brief()).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(getTask(db, "t1", "auth")?.status).toBe("IN_PROGRESS");
    const again = await spawnForTask(db, req());
    expect(again).toMatchObject({ state: "unknown", replay: true });
    expect(again.reason).toMatch(/no receipt/);
    expect(hook.texts).toHaveLength(1);
  });

  it("an unexpected transport failure after 'sending' is UNKNOWN, not reaped", async () => {
    hook.mode = "throws";
    const out = await spawnForTask(db, req());
    expect(out.state).toBe("unknown");
    expect(receipt()?.state).toBe("unknown");
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(getTask(db, "t1", "auth")?.status).toBe("IN_PROGRESS");
  });
});

describe("delegate session dir", () => {
  const sessionEnv = (calls: string[][]): string[] =>
    calls.flat().filter((a) => a.startsWith("PI_CODING_AGENT_SESSION_DIR="));

  it("a delegate task's pi pane keeps its session under the DB dir, out of the caller's /resume list", async () => {
    mux.restore();
    const m = mockTmux(freshMockState());
    mux = installMux("tmux", m.executor);
    addTask(db, {
      localId: "d1",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
      kind: "delegate",
    });
    await spawnForTask(db, {
      task: "d1",
      text: "check it",
      spawn: { name: "delegate-1", workstream: "auth", cli: "claude", command: "pi", ctl: false },
    });
    expect(sessionEnv(m.calls)).toEqual([
      `PI_CODING_AGENT_SESSION_DIR=${join(dir, "delegate-sessions", "auth")}`,
    ]);
  });

  it("a work task's pane keeps pi's default session dir", async () => {
    mux.restore();
    const m = mockTmux(freshMockState());
    mux = installMux("tmux", m.executor);
    await spawnForTask(db, req());
    expect(sessionEnv(m.calls)).toEqual([]);
  });
});
