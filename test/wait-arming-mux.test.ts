// Arming on the mux transport (v_wait_arming): a delivered paste to a non-pi pane is owed a
// wait with no run fence; an undelivered one, and a delivery-UNKNOWN task spawn, owe no run.
// The transport is mocked (the herdr/tmux paste itself is not under test).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({ mode: "ok" as "ok" | "undelivered" }));
vi.mock("../src/agents/transport.js", async (orig) => {
  const real = await orig<typeof import("../src/agents/transport.js")>();
  return {
    ...real,
    sendViaTransport: async (
      _agent: unknown,
      _text: string,
      o: { onUndelivered?: (w: unknown) => void },
    ) => {
      if (hook.mode === "undelivered") {
        o.onUndelivered?.({ paneId: "%1", reason: "paste-vanished", message: "never registered" });
      }
      return { transport: "mux" };
    },
  };
});

import {
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { readWaitRegistration } from "../src/wait-registration.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mwm-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "gate", workstream: "auth", paneId: "%1", cli: "claude" });
  mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  hook.mode = "ok";
});
afterEach(() => {
  mux.restore();
  resetCommandResolverForTests();
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function send(): Promise<void> {
  db.close();
  await withEnv("PI_SESSION_ID", "s1", async () => {
    await runCliJson(["agent", "send", "gate", "go", "-w", "auth", "--json"], dbPath);
  });
  db = openDb({ path: dbPath });
}

describe("send to a non-pi pane", () => {
  it("a delivered paste owes a wait with NO run fence (a pane has no run count)", async () => {
    await send();
    const reg = readWaitRegistration(db, "pi:s1");
    expect(reg?.refs).toEqual([{ kind: "agent", workstream: "auth", id: "gate" }]);
    expect(reg?.baselines).toEqual({});
  });

  it("an UNDELIVERED paste owes nothing (the prompt may never have landed)", async () => {
    hook.mode = "undelivered";
    await send();
    expect(readWaitRegistration(db, "pi:s1")).toBeUndefined();
  });
});

describe("spawn --task with a non-pi agent", () => {
  async function spawnTask(): Promise<Awaited<ReturnType<typeof runCliJson>>> {
    mux.restore();
    mux = installMux("tmux", mockTmux(freshMockState()).executor);
    addTask(db, { localId: "t1", workstream: "auth", title: "T", impact: 50, effortDays: 1 });
    db.close();
    let out: Awaited<ReturnType<typeof runCliJson>> | undefined;
    await withEnv("PI_SESSION_ID", "s1", async () => {
      out = await runCliJson(
        [
          "agent",
          "spawn",
          "worker-1",
          "-w",
          "auth",
          "--cli",
          "claude",
          "--task",
          "t1",
          "--send",
          "do t1",
          "--json",
        ],
        dbPath,
      );
    });
    db = openDb({ path: dbPath });
    if (out === undefined) throw new Error("no capture");
    return out;
  }

  it("a delivered paste arms the task and the agent (no fence)", async () => {
    const r = await spawnTask();
    expect(r.exitCode).toBeNull();
    const reg = readWaitRegistration(db, "pi:s1");
    expect(reg?.refs).toEqual([
      { kind: "agent", workstream: "auth", id: "worker-1" },
      { kind: "task", workstream: "auth", id: "t1" },
    ]);
    expect(reg?.baselines).toEqual({});
  });

  it("a delivery-UNKNOWN paste arms the TASK only: the prompt may never have landed", async () => {
    hook.mode = "undelivered";
    const r = await spawnTask();
    expect(r.exitCode).toBe(1);
    expect(readWaitRegistration(db, "pi:s1")?.refs).toEqual([
      { kind: "task", workstream: "auth", id: "t1" },
    ]);
  });
});
