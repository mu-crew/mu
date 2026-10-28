// remote_recovery (v_remote_recovery part A): every path that deletes a
// finalized remote-worktree agent row first writes a machine-local recovery
// record, in the deleter's own transaction. Real SQLite in a temp dir, mocked
// mux, no real host. Part B (close/collect readers) is not covered here.
//
//   reap        reconcile / deleteAgent: one record, task reopened, CAS miss keeps nothing
//   rollback    a throw mid-reap leaves no record and the row in place
//   teardown    dead rows go through the reaper (owned tasks reopen); alive ones are kept
//   reinit      records outlive the torn-down workstream they came from
//   cascade     a peer's workstream tombstone snapshots the cascaded rows
//   identity    one record per ORIGINAL incarnation; names and generations never merge
//   trigger     the database writes the record: `mu db query` deletes (agent, workstream),
//               a rollback, a missing trigger repaired on open, the aside/asideOf pin
//   shape       no foreign key, no ops, survives reopen, profile identity pinned
//   close       `agent close` removed the tree itself: it leaves no record

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeAgent,
  deleteAgent,
  getAgent,
  getAgentForCleanup,
  insertAgent,
} from "../src/agents.js";
import { applyOp, type Op } from "../src/apply.js";
import { type DbQueryOptions, cmdDbQuery as runDbQuery } from "../src/cli/db-query.js";
import { type Db, openDb } from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import { addHost, removeHost } from "../src/hosts.js";
import { reconcile } from "../src/reconcile.js";
import { asideOf } from "../src/remote-agent.js";
import { listRemoteRecoveries } from "../src/remote-recovery.js";
import { listNotes } from "../src/tasks/queries.js";
import { addTask, claimTask, getTask } from "../src/tasks.js";
import {
  ensureWorkstream,
  reinitWorkstream,
  teardownWorkstream,
  WorkstreamRevisionMismatchError,
  workstreamRevision,
} from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

const cmdDbQuery = (db: Db, q: string, o: DbQueryOptions = {}): Promise<void> =>
  runDbQuery(db, q, { write: true, ...o }); // these tests drive writes; the read-only default is test/sql-write-optin.test.ts

const BASE = "b".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/auth/w1";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness | undefined;

/** A tmux where every pane is dead and every session is gone. */
const deadMux = (): MuxHarness =>
  installMux("tmux", [
    ["list-panes", { stdout: "", exitCode: 1, stderr: "can't find session" }],
    ["display-message", { stdout: "", exitCode: 1, stderr: "can't find pane" }],
  ]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-remote-recovery-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  addHost(db, {
    name: "dev",
    shell: "true",
    exec: "/bin/sh -c {cmd}",
    fetch: "true {cwd}",
    repo: "/srv/repo",
    max_sessions: null,
  });
  mux = deadMux();
});

afterEach(() => {
  mux?.restore();
  mux = undefined;
  try {
    db.close();
  } catch {
    // already closed
  }
  rmFixtureDir(dir);
});

/** A finalized remote row: host, worktree path and base all recorded. */
const remote = (
  over: { name?: string; workstream?: string; pane?: string; cwd?: string | null } = {},
) =>
  insertAgent(db, {
    name: over.name ?? "w1",
    workstream: over.workstream ?? "auth",
    paneId: over.pane ?? "%1",
    cwd: over.cwd === undefined ? WT : over.cwd,
    base: BASE,
    host: "dev",
    // Not the profile's default (/srv/repo): the record must carry the row's own repo.
    repo: "/srv/per-spawn",
    collectedHead: "c".repeat(40),
  });
const records = () => listRemoteRecoveries(db);
const own = async (local: string, agent = "w1", workstream = "auth") => {
  addTask(db, { localId: local, workstream, title: local, impact: 50, effortDays: 1 });
  await claimTask(db, local, { agentName: agent, workstream });
};

describe("reap (deleteAgent, reconcile)", () => {
  it("reconcile pruning a ghost keeps ONE recovery record of the worktree, and reopens its task", async () => {
    const row = remote();
    await own("t1");
    const r = await reconcile(db, { workstream: "auth" });
    expect(r.prunedGhosts).toBe(1);
    expect(getAgent(db, "w1", "auth")).toBeUndefined();
    expect(records()).toEqual([
      expect.objectContaining({
        agentId: row.incarnation,
        workstream: "auth",
        name: "w1",
        paneId: "%1",
        host: "dev",
        cwd: WT,
        base: BASE,
        collectedHead: "c".repeat(40),
        aside: `${WT}.mu-removing-${row.incarnation}`,
        reason: "reap",
      }),
    ]);
    expect(getTask(db, "t1", "auth")).toMatchObject({ status: "OPEN", ownerName: null });
    // A second reconcile finds nothing to prune and adds nothing.
    await reconcile(db, { workstream: "auth" });
    expect(records()).toHaveLength(1);
  });

  it("local, cwd-only and base-less rows produce no record", () => {
    insertAgent(db, { name: "loc", workstream: "auth", paneId: "%2", cwd: "/x", base: BASE });
    insertAgent(db, { name: "nocwd", workstream: "auth", paneId: "%3", host: "dev", base: BASE });
    insertAgent(db, { name: "nobase", workstream: "auth", paneId: "%4", host: "dev", cwd: WT });
    for (const n of ["loc", "nocwd", "nobase"]) expect(deleteAgent(db, n, "auth")).toBe(true);
    expect(records()).toEqual([]);
  });

  it("a failed identity CAS preserves nothing and deletes nothing", () => {
    remote();
    expect(deleteAgent(db, "w1", "auth", { paneId: "%other" })).toBe(false);
    expect(deleteAgent(db, "w1", "auth", { incarnation: 999 })).toBe(false);
    expect(getAgent(db, "w1", "auth")).toBeDefined();
    expect(records()).toEqual([]);
  });

  it("a throw mid-reap rolls the record back with the row", async () => {
    remote();
    await own("t1");
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const stmt = original(sql);
      if (!sql.includes("INSERT INTO task_notes")) return stmt;
      return new Proxy(stmt, {
        get(t, p, r) {
          if (p === "run") {
            return () => {
              throw new Error("simulated failure after the delete");
            };
          }
          return Reflect.get(t, p, r);
        },
      });
    }) as typeof db.prepare;
    expect(() => deleteAgent(db, "w1", "auth")).toThrow(/simulated failure/);
    (db as unknown as { prepare: typeof db.prepare }).prepare = original;
    expect(getAgent(db, "w1", "auth")).toBeDefined();
    expect(records()).toEqual([]);
    expect(getTask(db, "t1", "auth")?.status).toBe("IN_PROGRESS");
  });

  it("`preserve: false` (the close that already removed the tree) writes no record", () => {
    remote();
    expect(deleteAgent(db, "w1", "auth", undefined, { preserve: false })).toBe(true);
    expect(records()).toEqual([]);
  });
});

describe("teardown", () => {
  const teardown = (ws = "auth") =>
    teardownWorkstream(db, { workstream: ws, ifRevision: workstreamRevision(db, ws) });

  it("snapshots a dead remote row and reopens what it owned (no ownerless IN_PROGRESS)", async () => {
    const row = remote();
    await own("t1");
    const res = await teardown();
    expect(res.deletedAgents).toBe(1);
    expect(getAgent(db, "w1", "auth")).toBeUndefined();
    expect(records()).toEqual([
      expect.objectContaining({ agentId: row.incarnation, reason: "teardown", cwd: WT }),
    ]);
    // tasks of a torn-down workstream are hidden from the live readers: ask SQL.
    expect(db.prepare("SELECT status, owner_id FROM tasks WHERE local_id = 't1'").get()).toEqual({
      status: "OPEN",
      owner_id: null,
    });
    const notes = db
      .prepare("SELECT content FROM task_notes WHERE content LIKE '[reaper]%'")
      .all() as { content: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("w1");
  });

  it("a row whose pane is alive is kept, with no record", async () => {
    remote();
    mux?.restore();
    mux = installMux("tmux", [
      ["list-panes", "@1\t%1\t_mu\n"],
      ["kill-session", ""],
      ["display-message", "%1\n"],
    ]);
    const res = await teardown();
    expect(res.orphanedAgents).toHaveLength(1);
    expect(getAgentForCleanup(db, "w1", "auth")).toBeDefined();
    expect(records()).toEqual([]);
  });

  it("an aborted commit (a racing agent changed the revision) preserves nothing and deletes nothing", async () => {
    remote();
    const rev = workstreamRevision(db, "auth");
    mux?.restore();
    mux = installMux("tmux", async (args) => {
      if (args[0] === "list-panes") return { stdout: "@1\t%1\t_mu\n", stderr: "", exitCode: 0 };
      if (args[0] === "kill-session") {
        insertAgent(db, { name: "racer", workstream: "auth", paneId: "%7" });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "can't find pane", exitCode: 1 };
    });
    await expect(teardownWorkstream(db, { workstream: "auth", ifRevision: rev })).rejects.toThrow(
      WorkstreamRevisionMismatchError,
    );
    expect(getAgent(db, "w1", "auth")).toBeDefined();
    expect(records()).toEqual([]);
  });

  it("a task of ANOTHER workstream owned by the row reopens too", async () => {
    remote();
    ensureWorkstream(db, "other");
    addTask(db, { localId: "x", workstream: "other", title: "x", impact: 50, effortDays: 1 });
    db.prepare(
      "UPDATE tasks SET owner_id = (SELECT id FROM agents), status = 'IN_PROGRESS', substate = 'active' WHERE local_id = 'x'",
    ).run();
    await teardown("other");
    await teardown();
    expect(records()).toHaveLength(1);
    expect(db.prepare("SELECT status, owner_id FROM tasks WHERE local_id = 'x'").get()).toEqual({
      status: "OPEN",
      owner_id: null,
    });
  });
});

describe("reinit", () => {
  it("the records outlive the torn-down workstream they came from", async () => {
    const row = remote();
    await teardownWorkstream(db, {
      workstream: "auth",
      ifRevision: workstreamRevision(db, "auth"),
    });
    await reinitWorkstream(db, "auth", workstreamRevision(db, "auth"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name = 'auth'").get()).toEqual({
      n: 1,
    });
    expect(records().map((r) => r.agentId)).toEqual([row.incarnation]);
  });
});

describe("peer workstream tombstone", () => {
  const PEER = "9f1c8a2e-0000-4000-8000-0000000000aa";
  const del = (key: string): Op => ({
    hlc: formatHlc({ wallMs: 2_000_000_000_000 + 9_000_000, counter: 0, machineId: PEER }),
    machineId: PEER,
    groupId: `g-${key}`,
    actor: "peer",
    intent: "workstream.teardown",
    entity: "workstream",
    key,
    op: "del",
    payload: "{}",
  });

  it("snapshots every remote row the cascade removes, and only those", () => {
    const a = remote();
    const b = remote({ name: "w2", pane: "%2", workstream: "keep" });
    insertAgent(db, { name: "loc", workstream: "auth", paneId: "%3" });
    expect(applyOp(db, del("auth")).changed).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE name <> 'w2'").get()).toEqual({
      n: 0,
    });
    expect(records()).toEqual([
      expect.objectContaining({ agentId: a.incarnation, reason: "workstream-delete" }),
    ]);
    expect(getAgent(db, "w2", "keep")?.incarnation).toBe(b.incarnation);
  });
});

describe("the database writes the record (AFTER DELETE trigger)", () => {
  const sql = async (q: string): Promise<void> => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmdDbQuery(db, q);
    } finally {
      log.mockRestore();
    }
  };

  it("`mu db query DELETE FROM agents` keeps the record", async () => {
    const row = remote();
    insertAgent(db, { name: "loc", workstream: "auth", paneId: "%3" });
    await sql("DELETE FROM agents");
    expect(getAgent(db, "w1", "auth")).toBeUndefined();
    expect(records()).toEqual([
      expect.objectContaining({
        agentId: row.incarnation,
        workstream: "auth",
        name: "w1",
        paneId: "%1",
        host: "dev",
        cwd: WT,
        base: BASE,
        collectedHead: "c".repeat(40),
        hostExec: "/bin/sh -c {cmd}",
        hostRepo: "/srv/per-spawn",
        reason: "reap",
      }),
    ]);
  });

  it("`mu db query DELETE FROM workstreams` keeps the record of every cascaded remote row", async () => {
    const a = remote();
    const b = remote({ name: "w2", pane: "%2" });
    remote({ name: "k", pane: "%5", workstream: "keep" });
    insertAgent(db, { name: "loc", workstream: "auth", paneId: "%3" });
    await sql("DELETE FROM workstreams WHERE name = 'auth'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE name <> 'k'").get()).toEqual({
      n: 0,
    });
    expect(records().map((r) => [r.agentId, r.workstream, r.reason, r.hostRepo])).toEqual([
      [a.incarnation, "auth", "workstream-delete", "/srv/per-spawn"],
      [b.incarnation, "auth", "workstream-delete", "/srv/per-spawn"],
    ]);
  });

  it("a rolled-back delete rolls the record back (agent delete and cascade)", () => {
    remote();
    for (const q of ["DELETE FROM agents", "DELETE FROM workstreams WHERE name = 'auth'"]) {
      expect(() =>
        db.transaction(() => {
          db.exec(q);
          expect(records()).toHaveLength(1);
          throw new Error("abort");
        })(),
      ).toThrow("abort");
      expect(records()).toEqual([]);
      expect(getAgent(db, "w1", "auth")).toBeDefined();
    }
  });

  it("a deleted workstream's record is written once, never overwritten by the agent trigger", () => {
    remote();
    db.exec("DELETE FROM workstreams WHERE name = 'auth'");
    expect(records()).toEqual([
      expect.objectContaining({ workstream: "auth", reason: "workstream-delete" }),
    ]);
  });

  it("the stored aside is exactly asideOf(cwd, incarnation)", () => {
    const row = remote();
    db.exec("DELETE FROM agents");
    expect(records()[0]?.aside).toBe(asideOf(WT, row.incarnation));
  });

  it("an already-v13 file whose triggers are missing gets them back on open", () => {
    remote({ name: "w1" });
    db.exec(
      "DROP TRIGGER remote_recovery_agent_del_v2; DROP TRIGGER remote_recovery_workstream_del_v2",
    );
    db.close();
    db = openDb({ path: dbPath });
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'remote_recovery%'",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(names.sort()).toEqual([
      "remote_recovery_agent_del_v2",
      "remote_recovery_workstream_del_v2",
    ]);
    db.exec("DELETE FROM agents");
    expect(records()).toHaveLength(1);
  });

  it("an older v13 file (repo-bound profiles, old triggers) loses both on open: no migration", () => {
    db.exec(`
      DROP TRIGGER remote_recovery_agent_del_v2;
      DROP TRIGGER remote_recovery_workstream_del_v2;
      CREATE TRIGGER remote_recovery_agent_del AFTER DELETE ON agents BEGIN SELECT 1; END;
      CREATE TRIGGER remote_recovery_workstream_del BEFORE DELETE ON workstreams BEGIN SELECT 1; END;
      DROP TABLE host_profiles;
      CREATE TABLE host_profiles (name TEXT PRIMARY KEY, shell TEXT NOT NULL, exec TEXT NOT NULL,
        fetch TEXT NOT NULL, repo TEXT NOT NULL, max_sessions INTEGER CHECK (max_sessions > 0));
      INSERT INTO host_profiles VALUES ('old', 's', 'e', 'f', '/r', NULL);
    `);
    db.close();
    db = openDb({ path: dbPath });
    const triggers = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'remote_recovery%'",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(triggers.sort()).toEqual([
      "remote_recovery_agent_del_v2",
      "remote_recovery_workstream_del_v2",
    ]);
    expect(db.prepare("SELECT name FROM host_profiles").all()).toEqual([]);
    expect(() =>
      addHost(db, {
        name: "dev2",
        shell: "s",
        exec: "e {cmd}",
        fetch: "f",
        repo: null,
        max_sessions: null,
      }),
    ).not.toThrow();
  });
});

describe("identity", () => {
  it("one record per ORIGINAL incarnation: two workstreams, same name, and a recreated generation", async () => {
    const a = remote({ workstream: "auth" });
    const b = remote({ workstream: "billing", pane: "%2" });
    expect(deleteAgent(db, "w1", "auth")).toBe(true);
    expect(deleteAgent(db, "w1", "billing")).toBe(true);
    // The same name again, in the same workstream: a new incarnation, a new record.
    const c = remote({ pane: "%3" });
    expect(deleteAgent(db, "w1", "auth")).toBe(true);
    const all = records();
    expect(all.map((r) => r.agentId).sort()).toEqual(
      [a.incarnation, b.incarnation, c.incarnation].sort(),
    );
    expect(new Set(all.map((r) => r.aside)).size).toBe(3);
  });

  it("a recreated workstream is another generation of the same name", async () => {
    const a = remote();
    await teardownWorkstream(db, {
      workstream: "auth",
      ifRevision: workstreamRevision(db, "auth"),
    });
    await reinitWorkstream(db, "auth", workstreamRevision(db, "auth"));
    const c = remote({ pane: "%9" });
    expect(deleteAgent(db, "w1", "auth")).toBe(true);
    const [first, second] = records();
    expect([first?.agentId, second?.agentId]).toEqual([a.incarnation, c.incarnation]);
    expect(first?.workstreamId).not.toBe(second?.workstreamId);
  });
});

describe("shape", () => {
  it("has no foreign key, adds no op, and survives deleting its host profile and reopening", async () => {
    const fks = db.prepare("PRAGMA foreign_key_list(remote_recovery)").all();
    expect(fks).toEqual([]);
    remote();
    const before = (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
    expect(deleteAgent(db, "w1", "auth")).toBe(true);
    // (the delete itself captures nothing: agents is machine-local)
    expect((db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n).toBe(before);
    expect(removeHost(db, "dev")).toBe(true);
    db.close();
    db = openDb({ path: dbPath });
    expect(records()).toHaveLength(1);
  });

  it("pins the profile's exec when it exists (nothing when it does not), and the row's repo", () => {
    remote();
    addHost(db, {
      name: "gone",
      shell: "true",
      exec: "/bin/true {cmd}",
      fetch: "true {cwd}",
      repo: "/srv/other",
      max_sessions: null,
    });
    insertAgent(db, {
      name: "w2",
      workstream: "auth",
      paneId: "%2",
      cwd: "/p",
      base: BASE,
      host: "ghost",
      repo: "/srv/ghost",
    });
    deleteAgent(db, "w1", "auth");
    deleteAgent(db, "w2", "auth");
    const [dev, ghost] = records();
    expect(dev).toMatchObject({ hostExec: "/bin/sh -c {cmd}", hostRepo: "/srv/per-spawn" });
    expect(ghost).toMatchObject({ host: "ghost", hostExec: null, hostRepo: "/srv/ghost" });
  });

  it("the reaper's own trail is unchanged: the owned task gets its [reaper] note", async () => {
    remote();
    await own("t1");
    deleteAgent(db, "w1", "auth");
    expect(listNotes(db, "t1", "auth").some((n) => n.content.startsWith("[reaper]"))).toBe(true);
  });
});

describe("agent close", () => {
  it("that removed the worktree itself leaves no record", async () => {
    mux?.restore();
    const state = freshMockState();
    mux = installMux("tmux", mockTmux(state).executor);
    const fake = join(dir, "fake-exec.sh");
    writeFileSync(
      fake,
      `#!/bin/sh\ncase "$1" in\n  *MU_STATE*) echo 'MU_STATE clean ${BASE}' ;;\n  *MU_RM*) echo 'MU_RM removed' ;;\nesac\n`,
    );
    chmodSync(fake, 0o755);
    addHost(db, {
      name: "fake",
      shell: "true",
      exec: `/bin/sh ${fake} {cmd}`,
      fetch: "true {cwd}",
      repo: "/srv/repo",
      max_sessions: null,
    });
    state.panes.set("%1", { windowId: "@1", paneId: "%1", command: "ssh" });
    insertAgent(db, {
      name: "w1",
      workstream: "auth",
      paneId: "%1",
      cwd: WT,
      base: BASE,
      host: "fake",
      repo: "/srv/repo",
    });
    const r = await closeAgent(db, "w1", { workstream: "auth" });
    expect(r.worktree).toMatchObject({ action: "removed" });
    expect(getAgent(db, "w1", "auth")).toBeUndefined();
    expect(records()).toEqual([]);
  });
});
