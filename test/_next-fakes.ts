// Shared fakes for the `executeNext` suites (next-executor, next-refute, next-recover):
// spawnAgent and the send transport are the only things faked, the journal, claim and
// replay are real. A suite installs them with
//
//   vi.mock("../src/agents/spawn.js", async (orig) =>
//     (await import("./_next-fakes.js")).spawnFake(await orig()));
//   vi.mock("../src/agents/transport.js", async (orig) =>
//     (await import("./_next-fakes.js")).transportFake(await orig()));
//
// and calls `resetHook()` in beforeEach. The knobs on `hook` are per suite.
//
// This file must not import src/agents.js (or anything that imports the mocked modules)
// at the top level: the factories run during collection, and awaiting a module that
// imports a module being mocked deadlocks it (0% CPU, no test timeout can fire because
// no test has started). `spawnFake` imports agents.js lazily, inside the fake.

import type { Db } from "../src/db.js";

interface Sent {
  agent: string;
  text: string;
  msgId?: string;
  expect?: string;
}

export const hook = {
  spawns: [] as string[],
  sends: [] as Sent[],
  checks: [] as string[],
  panes: 0,
  spawnFails: undefined as undefined | (() => Error),
  afterSpawn: undefined as undefined | (() => void),
  /** "unsent": the ctl socket was unreachable, so nothing was written. */
  sendMode: "ok" as "ok" | "throws" | "unsent",
  /** The run count pi reports before a send. */
  sendRuns: 0,
  checkState: "unreachable" as "accepted" | "not-accepted" | "unreachable",
};

export function resetHook(): void {
  hook.spawns = [];
  hook.sends = [];
  hook.checks = [];
  hook.panes = 0;
  hook.spawnFails = undefined;
  hook.afterSpawn = undefined;
  hook.sendMode = "ok";
  hook.sendRuns = 0;
  hook.checkState = "unreachable";
}

export function spawnFake<T extends object>(actual: T): T {
  return {
    ...actual,
    spawnAgent: async (
      db: Db,
      opts: { name: string; workstream: string; onIdentity?: (a: unknown) => void },
    ) => {
      const { insertAgent } = await import("../src/agents.js");
      hook.spawns.push(opts.name);
      if (hook.spawnFails !== undefined) throw hook.spawnFails();
      const row = insertAgent(db, {
        name: opts.name,
        workstream: opts.workstream,
        paneId: `%${++hook.panes}`,
      });
      opts.onIdentity?.(row);
      hook.afterSpawn?.();
      return { ...row, ctl: "ok", ctlSocket: "/fake.sock", ctlIncarnation: "pi-inc" };
    },
  };
}

export function transportFake<T extends object>(actual: T): T {
  return {
    ...actual,
    sendViaTransport: async (
      a: { name: string },
      text: string,
      o: { msgId?: string; expectIncarnation?: string },
    ) => {
      hook.sends.push({
        agent: a.name,
        text,
        ...(o.msgId !== undefined ? { msgId: o.msgId } : {}),
        ...(o.expectIncarnation !== undefined ? { expect: o.expectIncarnation } : {}),
      });
      if (hook.sendMode === "throws") throw new Error("socket vanished mid-write");
      if (hook.sendMode === "unsent") {
        const { AgentCtlUnreachableError } = await import("../src/agents/errors.js");
        throw new AgentCtlUnreachableError(a.name, "d", "/fake.sock", "missing", null);
      }
      return { transport: "ctl", runs: hook.sendRuns, msgId: o.msgId, incarnation: "pi-inc" };
    },
    checkMessage: async (_s: string, msgId: string) => {
      hook.checks.push(msgId);
      return hook.checkState === "accepted"
        ? { state: "accepted", incarnation: "pi-inc", runs: 1 }
        : hook.checkState === "not-accepted"
          ? { state: "not-accepted" }
          : { state: "unreachable", id: msgId, reason: "no socket" };
    },
  };
}
