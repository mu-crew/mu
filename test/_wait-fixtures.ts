// Shared fixtures for the wait-engine tests: a real SQLite DB, scripted agent
// readers (no ctl, no mux), delegate and task helpers.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { finishDelegate, markDelegate, registerDelegateCall } from "../src/delegates.js";
import { claimTask } from "../src/tasks/claim.js";
import { addTask } from "../src/tasks/edit.js";
import type { AgentReading, AgentWatchHandle, WaitOptions, WaitRef } from "../src/wait.js";
import { rmFixtureDir } from "./_fs.js";

export interface WaitEnv {
  db: Db;
  dir: string;
}

/** A fresh DB per test, closed and removed after. */
export function useWaitDb(): WaitEnv {
  const env = {} as WaitEnv;
  beforeEach(() => {
    env.dir = mkdtempSync(join(tmpdir(), "mu-wait-engine-"));
    env.db = openDb({ path: join(env.dir, "mu.db") });
  });
  afterEach(() => {
    try {
      env.db.close();
    } catch {}
    rmFixtureDir(env.dir);
  });
  return env;
}

export const taskRef = (id: string, workstream = "w"): WaitRef => ({
  kind: "task",
  workstream,
  id,
});
export const agentRef = (id: string, workstream = "w"): WaitRef => ({
  kind: "agent",
  workstream,
  id,
});
export const delegateRef = (id: string, workstream = "scratch"): WaitRef => ({
  kind: "delegate",
  workstream,
  id,
});

export function mkTask(db: Db, id: string, ws = "w"): void {
  addTask(db, { workstream: ws, localId: id, title: id });
}

export async function mkOwnedTask(db: Db, id: string, agent: string, ws = "w"): Promise<void> {
  mkTask(db, id, ws);
  if (!db.prepare("SELECT 1 FROM agents WHERE name = ?").get(agent)) {
    insertAgent(db, { name: agent, workstream: ws, paneId: `%${agent}`, cli: "pi" });
  }
  await claimTask(db, id, { workstream: ws, agentName: agent });
}

export function mkAgent(db: Db, name: string, ws = "w", cli = "pi"): number {
  return insertAgent(db, { name, workstream: ws, paneId: `%${name}`, cli }).incarnation;
}

let n = 0;
/** A delegate call (running) of `caller`, in `scratch`. */
export function mkDelegate(
  db: Db,
  caller: string,
  over: { wave?: string; record?: { workstream: string; task: string }; ws?: string } = {},
): string {
  const callId = `${caller}:c${++n}`;
  registerDelegateCall(db, {
    callId,
    caller,
    workstream: over.ws ?? "scratch",
    request: { text: `check ${callId}` },
    state: "starting",
    ...(over.wave !== undefined ? { wave: over.wave } : {}),
    ...(over.record !== undefined ? { record: over.record } : {}),
  });
  markDelegate(db, callId, "running", { agent: `d-${callId}` });
  return callId;
}

export const answer = (db: Db, callId: string, text = "VERDICT: CONFIRMED\nok") =>
  finishDelegate(db, callId, { outcome: "done", text, author: `d-${callId}` });

/** Agent readers that read from a mutable table (no ctl). */
export function scriptedAgents(table: Map<string, AgentReading>): Pick<
  WaitOptions,
  "readAgents"
> & {
  reads: { n: number };
} {
  const reads = { n: 0 };
  return {
    reads,
    readAgents: async (refs) => {
      reads.n++;
      return new Map(
        refs.flatMap((r) => {
          const v = table.get(`${r.workstream}/${r.id}`);
          return v === undefined ? [] : [[`${r.workstream}/${r.id}`, v] as const];
        }),
      );
    },
  };
}

/** A controllable ctl-style watch: settle() resolves it, `reject` fails it. */
export function controllableWatch(initial: AgentReading = { status: "busy" }) {
  let settle: (r: AgentReading) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const settled = new Promise<AgentReading>((res, rej) => {
    settle = res;
    reject = rej;
  });
  const handle: AgentWatchHandle = { initial, settled };
  return { handle, settle, reject };
}

export const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));
