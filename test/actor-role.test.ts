// Actor role: ops record the capacity ('orchestrator' | 'worker' | 'delegate')
// the session acted in, resolved for the op's target workstream, actor, and session.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAgent, insertAgent } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { markDelegate, registerDelegateCall } from "../src/delegates.js";
import { writeEffect } from "../src/effects.js";
import * as sdk from "../src/index.js";
import { appendLog, emitEvent, listLogs, listSessionRoles } from "../src/logs.js";
import { currentOpContext, withOpContext } from "../src/op-context.js";
import { resolveActorRole } from "../src/provenance.js";
import { claimTask } from "../src/tasks/claim.js";
import { addNote, addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-role-"));
});
afterEach(() => rmFixtureDir(dir));

/** Run `fn` with each of `vars` set (undefined: unset), restored after. */
async function withEnvs(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const entries = Object.entries(vars);
  const go = async (i: number): Promise<void> => {
    const e = entries[i];
    if (e === undefined) return fn();
    await withEnv(e[0], e[1], () => go(i + 1));
  };
  await go(0);
}

const ORCH = {
  MU_ACTOR_SESSION: "pi:orch",
  PI_SESSION_ID: undefined,
  MU_MANAGED_AGENT: undefined,
  MU_ORCHESTRATOR: undefined,
  MU_DELEGATE: undefined,
};
const WORKER = {
  MU_ACTOR_SESSION: "pi:w1",
  PI_SESSION_ID: undefined,
  MU_MANAGED_AGENT: "1",
  MU_WORKSTREAM: "w",
  MU_AGENT_NAME: "w1",
  MU_ORCHESTRATOR: undefined,
  MU_DELEGATE: undefined,
};
const SESSIONLESS = {
  MU_ACTOR_SESSION: undefined,
  PI_SESSION_ID: undefined,
  MU_MANAGED_AGENT: undefined,
  MU_ORCHESTRATOR: undefined,
  MU_DELEGATE: undefined,
};

describe("actor_role", () => {
  it("records a non-agent session's task.add as orchestrator, and a plain note as unknown", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      ensureWorkstream(db, "w");
      await withEnvs(ORCH, () => {
        addTask(db, { workstream: "w", localId: "t", title: "T" });
        addNote(db, "t", "just a note", { workstream: "w" });
      });
      const rows = listLogs(db, {});
      const add = rows.find((r) => r.intent === "task.add");
      expect(add).toMatchObject({ actorSession: "pi:orch", actorRole: "orchestrator" });
      expect(rows.find((r) => r.kind === "note")?.actorRole).toBeNull();
    } finally {
      db.close();
    }
  });

  it("records a registered worker's ops in its own workstream as worker, even an orchestration intent", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      insertAgent(db, { name: "w1", workstream: "w", paneId: "%1" });
      await withEnvs(WORKER, () => {
        addTask(db, { workstream: "w", localId: "t", title: "T" });
        appendLog(db, { workstream: "w", source: "w1", payload: "hi" });
      });
      const mine = listLogs(db, {}).filter((r) => r.actorSession === "pi:w1");
      expect(mine.length).toBeGreaterThan(1);
      for (const r of mine) expect(r.actorRole).toBe("worker");
    } finally {
      db.close();
    }
  });

  it("resolves against the op's target workstream, never env MU_WORKSTREAM alone", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      insertAgent(db, { name: "w1", workstream: "alpha", paneId: "%1" });
      // Even if beta ALSO has an agent named w1, alpha's w1 is not a worker of beta.
      insertAgent(db, { name: "w1", workstream: "beta", paneId: "%2" });
      const alphaWorker = { ...WORKER, MU_WORKSTREAM: "alpha" };
      await withEnvs(alphaWorker, () => {
        addTask(db, { workstream: "alpha", localId: "a1", title: "A1" });
        addTask(db, { workstream: "beta", localId: "b1", title: "B1" });
        addNote(db, "b1", "cross-ws note", { workstream: "beta" });
        appendLog(db, { workstream: "beta", source: "w1", payload: "cross-ws log" });
      });
      const rows = listLogs(db, {}).filter((r) => r.actorSession === "pi:w1");
      expect(rows.find((r) => r.key === "alpha/a1")?.actorRole).toBe("worker");
      expect(rows.find((r) => r.key === "beta/b1" && r.intent === "task.add")?.actorRole).toBe(
        "orchestrator",
      );
      expect(rows.find((r) => r.key.startsWith("beta/b1#"))?.actorRole).toBeNull();
      expect(rows.find((r) => r.key === "beta" && r.kind === "message")?.actorRole).toBeNull();

      const roles = listSessionRoles(db).map(({ lastSeq: _, ...r }) => r);
      expect(roles).toContainEqual({ actorSession: "pi:w1", workstream: "alpha", role: "worker" });
      expect(roles).toContainEqual({
        actorSession: "pi:w1",
        workstream: "beta",
        role: "orchestrator",
      });
      expect(roles).not.toContainEqual({
        actorSession: "pi:w1",
        workstream: "beta",
        role: "worker",
      });
    } finally {
      db.close();
    }
  });

  it("passive/system ops (reaper, lost-delivery agent.send, system actor) never confer a role", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      ensureWorkstream(db, "w");
      addTask(db, { workstream: "w", localId: "t1", title: "T1" });
      const agent = insertAgent(db, { name: "w1", workstream: "w", paneId: "%1" });
      await claimTask(db, "t1", { workstream: "w", agentName: "w1" });
      writeEffect(db, {
        key: "k1",
        subject: { kind: "delivery", agentId: agent.incarnation, msgId: "m1" },
        plugin: "demo",
        method: "send",
        params: {},
        instance: "inst1",
        pgid: 1,
        pgidStart: null,
      });

      // A passive viewer running reconcile / mu state triggers deleteAgent -> task.reap,
      // lost-delivery agent.send, and reaper task.note. None may stamp orchestrator.
      await withEnvs({ ...ORCH, MU_ACTOR_SESSION: "pi:viewer" }, () => {
        deleteAgent(db, "w1", "w");
        emitEvent(db, "w", "agent.send", "system event", "system");
        emitEvent(db, "w", "agent.close", "system close", "system");
      });

      const viewerOps = listLogs(db, {}).filter((r) => r.actorSession === "pi:viewer");
      expect(viewerOps.length).toBeGreaterThanOrEqual(4);
      for (const r of viewerOps) {
        expect(r.actorRole).toBeNull();
      }
      expect(listSessionRoles(db).filter((r) => r.actorSession === "pi:viewer")).toEqual([]);
      expect(
        resolveActorRole(
          db,
          { intent: "task.add", workstream: "w", actor: "mu delegates prune" },
          { ...ORCH, MU_ORCHESTRATOR: "1" },
        ),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("identifies delegates (via MU_DELEGATE=1 or delegate_calls) and never mislabels them as orchestrator or worker", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      ensureWorkstream(db, "scratch");
      const { call } = registerDelegateCall(db, {
        callId: "call-1",
        caller: "pi:orch",
        workstream: "scratch",
        request: { text: "check", label: "rev" },
      });
      // Deliberate name clash: an agents row shares call.task's name.
      insertAgent(db, { name: call.task, workstream: "scratch", paneId: "%9" });

      // 1. Explicit MU_DELEGATE=1 marker (set by src/delegate-process.ts).
      const delMarked = {
        MU_ACTOR_SESSION: "pi:del1",
        PI_SESSION_ID: undefined,
        MU_MANAGED_AGENT: "1",
        MU_DELEGATE: "1",
        MU_WORKSTREAM: "scratch",
        MU_AGENT_NAME: call.task,
        MU_ORCHESTRATOR: undefined,
      };
      await withEnvs(delMarked, () => {
        addTask(db, { workstream: "scratch", localId: "d1", title: "D1" });
        addTask(db, { workstream: "other", localId: "d2", title: "D2" });
        addNote(db, "d1", "delegate note", { workstream: "scratch" });
      });
      const del1Ops = listLogs(db, {}).filter((r) => r.actorSession === "pi:del1");
      expect(del1Ops.length).toBeGreaterThanOrEqual(3);
      for (const r of del1Ops) expect(r.actorRole).toBe("delegate");

      // 2. Fallback via delegate_calls when MU_DELEGATE is unset (still beats name clash!).
      const delFallback = { ...delMarked, MU_ACTOR_SESSION: "pi:del2", MU_DELEGATE: undefined };
      expect(resolveActorRole(db, { intent: "task.add", workstream: "scratch" }, delFallback)).toBe(
        "delegate",
      );
      expect(
        resolveActorRole(db, { intent: "task.note", workstream: "scratch" }, delFallback),
      ).toBe("delegate");
      expect(
        resolveActorRole(db, { intent: "agent.spawn", workstream: "other" }, delFallback),
      ).toBe("delegate");

      const roles = listSessionRoles(db).map(({ lastSeq: _, ...r }) => r);
      expect(roles).toContainEqual({
        actorSession: "pi:del1",
        workstream: "scratch",
        role: "delegate",
      });
      expect(roles).toContainEqual({
        actorSession: "pi:del1",
        workstream: "other",
        role: "delegate",
      });
    } finally {
      db.close();
    }
  });

  it("identifies a pane delegate (agent delegate-<stem> owning the call task) without MU_DELEGATE", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      ensureWorkstream(db, "scratch");
      const { call } = registerDelegateCall(db, {
        callId: "call-pane",
        caller: "pi:orch",
        workstream: "scratch",
        request: { text: "check", label: "rev" },
      });
      markDelegate(db, call.callId, "starting");
      insertAgent(db, { name: "delegate-rev", workstream: "scratch", paneId: "%9" });
      await claimTask(db, call.task, { workstream: "scratch", agentName: "delegate-rev" });
      // src/agents/spawn.ts clears MU_DELEGATE for pane agents.
      const paneEnv = {
        MU_ACTOR_SESSION: "pi:del-pane-1",
        MU_MANAGED_AGENT: "1",
        MU_DELEGATE: "",
        MU_WORKSTREAM: "scratch",
        MU_AGENT_NAME: "delegate-rev",
      };
      expect(resolveActorRole(db, { intent: "task.note", workstream: "scratch" }, paneEnv)).toBe(
        "delegate",
      );
      expect(resolveActorRole(db, { intent: "task.add", workstream: "target-ws" }, paneEnv)).toBe(
        "delegate",
      );
      // Another agent of the workstream that owns no delegate call stays a worker.
      insertAgent(db, { name: "w2", workstream: "scratch", paneId: "%8" });
      expect(
        resolveActorRole(
          db,
          { intent: "task.note", workstream: "scratch" },
          { ...paneEnv, MU_AGENT_NAME: "w2" },
        ),
      ).toBe("worker");
      // A same-named agent of another workstream owning the call does not make scratch/w1 one.
      ensureWorkstream(db, "other");
      const { call: call2 } = registerDelegateCall(db, {
        callId: "pi:orch:c2",
        caller: "pi:orch",
        workstream: "scratch",
        request: { text: "check", label: "rev2" },
      });
      markDelegate(db, call2.callId, "starting");
      insertAgent(db, { name: "w1", workstream: "other", paneId: "%7" });
      await claimTask(db, call2.task, {
        workstream: "scratch",
        agentName: "w1",
        agentWorkstream: "other",
      });
      insertAgent(db, { name: "w1", workstream: "scratch", paneId: "%6" });
      const w1Env = { ...paneEnv, MU_AGENT_NAME: "w1" };
      expect(resolveActorRole(db, { intent: "task.note", workstream: "scratch" }, w1Env)).toBe(
        "worker",
      );
      // The delegate's row deleted and its name reused: the new agent owns no call.
      deleteAgent(db, "delegate-rev", "scratch");
      insertAgent(db, { name: "delegate-rev", workstream: "scratch", paneId: "%5" });
      expect(resolveActorRole(db, { intent: "task.note", workstream: "scratch" }, paneEnv)).toBe(
        "worker",
      );
    } finally {
      db.close();
    }
  });

  it("sessionless ops record actor_role null, and explicit ctx.actorSession resolves for that session, not process.env", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      insertAgent(db, { name: "w1", workstream: "w", paneId: "%1" });

      // Sessionless human shell: even task.add and MU_ORCHESTRATOR=1 yield null without a session.
      await withEnvs(SESSIONLESS, () => {
        addTask(db, { workstream: "w", localId: "t1", title: "T1" });
      });
      await withEnvs({ ...SESSIONLESS, MU_ORCHESTRATOR: "1" }, () => {
        addTask(db, { workstream: "w", localId: "t2", title: "T2" });
      });
      const t1 = listLogs(db, {}).find((r) => r.key === "w/t1");
      const t2 = listLogs(db, {}).find((r) => r.key === "w/t2");
      expect(t1).toMatchObject({ actorSession: null, actorRole: null });
      expect(t2).toMatchObject({ actorSession: null, actorRole: null });

      // Explicit ctx.actorSession different from process.env (worker pi:w1) must NOT inherit worker role.
      await withEnvs(WORKER, () => {
        withOpContext(
          db,
          { intent: "task.note", workstream: "w", actorSession: "pi:external" },
          () => {
            expect(currentOpContext(db).actorRole).toBeNull();
          },
        );
        withOpContext(
          db,
          { intent: "task.add", workstream: "w", actorSession: "pi:external" },
          () => {
            expect(currentOpContext(db).actorRole).toBe("orchestrator");
          },
        );
        // Explicit ctx.actorSession matching process.env DOES resolve using process.env.
        withOpContext(db, { intent: "task.note", workstream: "w", actorSession: "pi:w1" }, () => {
          expect(currentOpContext(db).actorRole).toBe("worker");
        });
      });
    } finally {
      db.close();
    }
  });

  it("MU_ORCHESTRATOR wins; an unregistered managed agent falls back to the intent", () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      insertAgent(db, { name: "w1", workstream: "w", paneId: "%1" });
      expect(
        resolveActorRole(
          db,
          { intent: "task.note", workstream: "w" },
          { ...WORKER, MU_ORCHESTRATOR: "1" },
        ),
      ).toBe("orchestrator");
      const ghost = { ...WORKER, MU_AGENT_NAME: "gone" };
      expect(resolveActorRole(db, { intent: "task.note", workstream: "w" }, ghost)).toBeNull();
      expect(resolveActorRole(db, { intent: "agent.spawn", workstream: "w" }, ghost)).toBe(
        "orchestrator",
      );
    } finally {
      db.close();
    }
  });

  it("caches prepared statements and avoids re-querying in nested withOpContext", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      ensureWorkstream(db, "w");
      insertAgent(db, { name: "w1", workstream: "w", paneId: "%1" });
      const prepareSpy = vi.spyOn(db, "prepare");

      // Repeated resolveActorRole calls compile the agents/delegate_calls SQL at most once.
      for (let i = 0; i < 5; i++) {
        expect(resolveActorRole(db, { intent: "task.note", workstream: "w" }, WORKER)).toBe(
          "worker",
        );
      }
      const agentPrepares = prepareSpy.mock.calls.filter(([sql]) =>
        String(sql).includes("FROM agents a JOIN workstreams"),
      );
      expect(agentPrepares).toHaveLength(1);

      // Nested withOpContext with an unregistered managed agent (outer resolves null)
      // must not re-run the lookup in inner non-orchestrating scopes.
      const ghost = { ...WORKER, MU_AGENT_NAME: "gone" };
      // Warm statement cache first.
      resolveActorRole(db, { intent: "task.note", workstream: "w" }, ghost);
      const cachedStmt = db.prepare(
        "SELECT 1 FROM agents a JOIN workstreams w ON w.id = a.workstream_id WHERE w.name = ? AND a.name = ?",
      );
      // Spy via a fresh DB where we count executions of the agents lookup.
      expect(cachedStmt).toBeDefined();
    } finally {
      db.close();
    }

    // Verify zero redundant lookup executions in nested withOpContext.
    const db2 = openDb({ path: join(dir, "mu2.db") });
    try {
      ensureWorkstream(db2, "w");
      const ghost = { ...WORKER, MU_AGENT_NAME: "gone" };
      const origPrepare = db2.prepare.bind(db2);
      let lookupRuns = 0;
      vi.spyOn(db2, "prepare").mockImplementation((sql: string) => {
        const stmt = origPrepare(sql);
        if (sql.includes("FROM agents a JOIN workstreams") || sql.includes("FROM delegate_calls")) {
          const origGet = stmt.get.bind(stmt);
          stmt.get = (...args: unknown[]) => {
            lookupRuns++;
            return origGet(...args);
          };
        }
        return stmt;
      });

      await withEnvs(ghost, () => {
        withOpContext(db2, { intent: "task.note", workstream: "w" }, () => {
          const afterOuter = lookupRuns;
          expect(afterOuter).toBeGreaterThan(0);
          withOpContext(db2, { intentIfUnset: "task.set-open", workstream: "w" }, () => {
            expect(currentOpContext(db2).actorRole).toBeNull();
          });
          withOpContext(db2, { intent: "task.close" }, () => {
            expect(currentOpContext(db2).actorRole).toBeNull();
          });
          expect(lookupRuns).toBe(afterOuter);
        });
      });
    } finally {
      db2.close();
    }
  });

  it("un-sourced emitEvent resolves actor identity; only an explicit system source nulls actor_role", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      insertAgent(db, { name: "w1", workstream: "w", paneId: "%1" });

      // Non-agent session with PI_SESSION_ID set and no MU_* vars (e.g. plugin-host agent.spawn).
      await withEnvs(
        {
          MU_ACTOR_SESSION: undefined,
          PI_SESSION_ID: "orch-probe",
          MU_MANAGED_AGENT: undefined,
          MU_WORKSTREAM: undefined,
          MU_AGENT_NAME: undefined,
          MU_ORCHESTRATOR: undefined,
          MU_DELEGATE: undefined,
        },
        () => {
          emitEvent(db, "w", "agent.spawn", "agent spawn p1 (host=plug)");
          emitEvent(db, "w", "agent.spawn", "explicit system spawn", "system");
        },
      );

      // Registered worker's un-sourced emitEvent (e.g. agent.reattach).
      await withEnvs(WORKER, () => {
        emitEvent(db, "w", "agent.reattach", "agent reattach w1 (host=h, job=j, pane=%1, ctl=ok)");
      });

      const rows = listLogs(db, { workstream: "w" });
      const unsourcedSpawn = rows.find((r) => r.payload.includes("host=plug"));
      expect(unsourcedSpawn).toMatchObject({
        intent: "agent.spawn",
        actorSession: "pi:orch-probe",
        actorRole: "orchestrator",
      });
      expect(unsourcedSpawn?.source).not.toBe("system");

      const explicitSystem = rows.find((r) => r.payload === "explicit system spawn");
      expect(explicitSystem).toMatchObject({
        intent: "agent.spawn",
        source: "system",
        actorSession: "pi:orch-probe",
        actorRole: null,
      });

      const workerReattach = rows.find((r) => r.intent === "agent.reattach");
      expect(workerReattach).toMatchObject({
        source: "w1",
        actorSession: "pi:w1",
        actorRole: "worker",
      });
    } finally {
      db.close();
    }
  });

  it("listSessionRoles answers who orchestrated what in one call, through the SDK, with since", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      insertAgent(db, { name: "w1", workstream: "w", paneId: "%1" });
      await withEnvs(ORCH, () => {
        addTask(db, { workstream: "w", localId: "a", title: "A" });
        addTask(db, { workstream: "x", localId: "b", title: "B" });
      });
      await withEnvs(WORKER, () => {
        appendLog(db, { workstream: "w", source: "w1", payload: "hi" });
      });
      const roles = sdk.listSessionRoles(db);
      expect(roles.map(({ lastSeq: _, ...r }) => r)).toEqual(
        expect.arrayContaining([
          { actorSession: "pi:orch", workstream: "w", role: "orchestrator" },
          { actorSession: "pi:orch", workstream: "x", role: "orchestrator" },
          { actorSession: "pi:w1", workstream: "w", role: "worker" },
        ]),
      );
      const newest = Math.max(...roles.map((r) => r.lastSeq));
      expect(listSessionRoles(db, { since: newest })).toEqual([]);
      const cut = roles.find((r) => r.workstream === "x")?.lastSeq ?? 0;
      expect(listSessionRoles(db, { since: cut }).map((r) => r.actorSession)).toEqual(["pi:w1"]);
    } finally {
      db.close();
    }
  });

  it("a read-only DB predating actor_role still reads logs, session roles, and currentOpContext", async () => {
    const path = join(dir, "mu.db");
    const db = openDb({ path });
    ensureWorkstream(db, "w");
    await withEnvs(ORCH, () => {
      addTask(db, { workstream: "w", localId: "t", title: "T" });
    });
    // Put the pre-column shape back on BOTH ops and op_ctx: drop triggers first.
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as {
      name: string;
    }[];
    for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
    db.exec("ALTER TABLE ops DROP COLUMN actor_role");
    db.exec("ALTER TABLE op_ctx DROP COLUMN actor_role");
    db.close();

    const ro = openDb({ path, readonly: true });
    try {
      const rows = listLogs(ro, {});
      expect(rows.find((r) => r.intent === "task.add")).toMatchObject({
        actorSession: "pi:orch",
        actorRole: null,
      });
      expect(listSessionRoles(ro)).toEqual([]);
      expect(currentOpContext(ro)).toMatchObject({ actorRole: null, applying: false });
    } finally {
      ro.close();
    }
  });
});
