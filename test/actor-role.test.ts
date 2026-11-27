// Actor role: ops record the capacity ('orchestrator' | 'worker') the session acted in.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { openDb } from "../src/db.js";
import * as sdk from "../src/index.js";
import { appendLog, listLogs, listSessionRoles } from "../src/logs.js";
import { resolveActorRole } from "../src/provenance.js";
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
async function withEnvs(vars: Record<string, string | undefined>, fn: () => void): Promise<void> {
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
  MU_MANAGED_AGENT: undefined,
  MU_ORCHESTRATOR: undefined,
};
const WORKER = {
  MU_ACTOR_SESSION: "pi:w1",
  MU_MANAGED_AGENT: "1",
  MU_WORKSTREAM: "w",
  MU_AGENT_NAME: "w1",
  MU_ORCHESTRATOR: undefined,
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

  it("records a registered worker's ops as worker, even an orchestration intent", async () => {
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

  it("MU_ORCHESTRATOR wins; an unregistered managed agent falls back to the intent", () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      insertAgent(db, { name: "w1", workstream: "w", paneId: "%1" });
      expect(resolveActorRole(db, "task.note", { ...WORKER, MU_ORCHESTRATOR: "1" })).toBe(
        "orchestrator",
      );
      const ghost = { ...WORKER, MU_AGENT_NAME: "gone" };
      expect(resolveActorRole(db, "task.note", ghost)).toBeNull();
      expect(resolveActorRole(db, "agent.spawn", ghost)).toBe("orchestrator");
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

  it("a read-only DB predating actor_role still reads: role null, no session roles", async () => {
    const path = join(dir, "mu.db");
    const db = openDb({ path });
    ensureWorkstream(db, "w");
    await withEnvs(ORCH, () => {
      addTask(db, { workstream: "w", localId: "t", title: "T" });
    });
    // Put the pre-column shape back: the triggers name the column, so drop them first.
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as {
      name: string;
    }[];
    for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
    db.exec("ALTER TABLE ops DROP COLUMN actor_role");
    db.close();

    const ro = openDb({ path, readonly: true });
    try {
      const rows = listLogs(ro, {});
      expect(rows.find((r) => r.intent === "task.add")).toMatchObject({
        actorSession: "pi:orch",
        actorRole: null,
      });
      expect(listSessionRoles(ro)).toEqual([]);
    } finally {
      ro.close();
    }
  });
});
