// Task-side guards (v_guards, part A): `--if <rev>` on delete / block /
// unblock / reparent / claim / release, the exact-key task revision behind
// it, and read-only `candidate_ids` on a wrong id.
//
// Revisions are tested through real SQLite ops. The CLI tests drive the
// verbs in-process, so the whole path (parse → ingest hook → fence → verb)
// is the one a user hits.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  assertRevision,
  RevisionMismatchError,
  taskRevision,
  taskRevisions,
} from "../src/revision.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask, deleteTask } from "../src/tasks/edit.js";
import { claimTask, getTask, getTaskEdges, releaseTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let path: string;
let db: Db;

const add = (ws: string, id: string): void => {
  addTask(db, { workstream: ws, localId: id, title: id, impact: 50, effortDays: 1 });
};
const opCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
const rev = (id: string, ws = "demo"): number => taskRevision(db, ws, id);
const edgeCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-revision-guards-"));
  path = join(dir, "mu.db");
  db = openDb({ path });
  ensureWorkstream(db, "demo");
  ensureWorkstream(db, "other");
  ensureWorkstream(db, "demo-2");
  for (const id of ["t", "u", "a_b", "axb", "blocker"]) add("demo", id);
  add("other", "t");
  add("demo-2", "t");
  insertAgent(db, { name: "w1", workstream: "demo", paneId: "%1" });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

describe("taskRevision", () => {
  it("is the exact-key partition: a sibling underscore id, another workstream and a prefix workstream never move it", () => {
    const r = rev("a_b");
    expect(r).toBeGreaterThan(0);
    addNote(db, "axb", "touch the lookalike (LIKE '_' would match)", { workstream: "demo" });
    addNote(db, "t", "same id elsewhere", { workstream: "other" });
    addNote(db, "t", "same id in a prefix sibling", { workstream: "demo-2" });
    expect(rev("a_b")).toBe(r);
    expect(rev("t", "other")).toBeGreaterThan(rev("t"));
  });

  it("moves on a note, a claim, and either end of an edge", () => {
    const seen = new Set<number>([rev("t")]);
    addNote(db, "t", "n", { workstream: "demo" });
    seen.add(rev("t"));
    addBlockEdge(db, "demo", "t", "u"); // t is blocked by u
    seen.add(rev("t"));
    expect(rev("u")).toBeGreaterThan(0);
    const uBefore = rev("u");
    addBlockEdge(db, "demo", "a_b", "t"); // t is the BLOCKER now
    expect(rev("t")).toBeGreaterThan(Math.max(...seen));
    expect(rev("a_b")).toBeGreaterThanOrEqual(rev("t"));
    expect(rev("u")).toBe(uBefore);
  });

  it("a synced edge op whose other end is in another workstream moves only the local end", () => {
    const r = rev("t");
    db.prepare(
      `INSERT INTO ops (hlc, machine_id, group_id, intent, entity, key, op, payload, created_at)
       VALUES ('9999-peer', 'peer', 'g', 'task.block', 'edge', 'demo/t->other/t', 'put', '{}', '2030-01-01')`,
    ).run();
    expect(rev("t")).toBeGreaterThan(r);
    expect(taskRevisions(db, "demo").has("2/t")).toBe(false);
    expect([...taskRevisions(db, "demo").keys()].every((k) => !k.includes("/"))).toBe(true);
  });

  it("an absent task is revision 0, and reading it writes nothing", () => {
    const ops = opCount();
    expect(rev("ghost")).toBe(0);
    expect(opCount()).toBe(ops);
  });

  it("a moved edge (removed behind the preview) makes the old revision stale", async () => {
    addBlockEdge(db, "demo", "t", "u");
    const r = rev("t");
    db.prepare(
      "DELETE FROM task_edges WHERE to_task_id = (SELECT id FROM tasks WHERE local_id = 't' AND workstream_id = (SELECT id FROM workstreams WHERE name = 'demo'))",
    ).run();
    expect(rev("t")).not.toBe(r);
  });
});

describe("assertRevision", () => {
  const ctx = { subject: "task t", previewCommand: "mu task show t -w demo" };
  it("passes with no --if and on a match; throws a typed error otherwise", () => {
    expect(() => assertRevision(undefined, 5, ctx)).not.toThrow();
    expect(() => assertRevision(5, 5, ctx)).not.toThrow();
    try {
      assertRevision(4, 5, ctx);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RevisionMismatchError);
      const err = e as RevisionMismatchError;
      expect([err.expectedRev, err.currentRev]).toEqual([4, 5]);
      expect(err.message).not.toContain("\n");
      expect(err.message).toContain("mu task show t -w demo");
    }
  });
});

describe("SDK fences refuse before any write", () => {
  it("deleteTask: stale → throws, task and ops untouched; fresh → deletes", () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const ops = opCount();
    expect(() => deleteTask(db, "t", "demo", { ifRevision: stale })).toThrow(RevisionMismatchError);
    expect(opCount()).toBe(ops);
    expect(getTask(db, "t", "demo")).toBeDefined();
    expect(deleteTask(db, "t", "demo", { ifRevision: rev("t") }).deleted).toBe(true);
  });

  it("deleteTask preview writes nothing and reports the revision", () => {
    const ops = opCount();
    const r = deleteTask(db, "t", "demo", { dryRun: true });
    expect(r.revision).toBe(rev("t"));
    expect(opCount()).toBe(ops);
  });

  it("deleteTask of a missing task stays a no-op even with a stale --if", () => {
    expect(deleteTask(db, "ghost", "demo", { ifRevision: 1 })).toMatchObject({
      present: false,
      deleted: false,
    });
  });

  it("claimTask --self and releaseTask: stale → throws, no owner/status change", async () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    await expect(
      claimTask(db, "t", { workstream: "demo", self: true, ifRevision: stale }),
    ).rejects.toBeInstanceOf(RevisionMismatchError);
    await expect(
      claimTask(db, "t", { workstream: "demo", agentName: "w1", ifRevision: stale }),
    ).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(getTask(db, "t", "demo")?.status).toBe("OPEN");
    await claimTask(db, "t", { workstream: "demo", agentName: "w1", ifRevision: rev("t") });
    expect(getTask(db, "t", "demo")?.ownerName).toBe("w1");
    const stale2 = rev("t") - 1;
    expect(() => releaseTask(db, "t", { workstream: "demo", ifRevision: stale2 })).toThrow(
      RevisionMismatchError,
    );
    expect(getTask(db, "t", "demo")?.ownerName).toBe("w1");
    releaseTask(db, "t", { workstream: "demo", ifRevision: rev("t") });
    expect(getTask(db, "t", "demo")?.ownerName).toBeNull();
  });
});

describe("CLI: task delete", () => {
  it("preview carries data.revision and the apply hint is --if <rev>", async () => {
    const ops = opCount();
    const r = await runCliJson(["task", "delete", "t", "-w", "demo", "--json"], path);
    expect(r.data).toMatchObject({ dryRun: true, present: true, revision: rev("t") });
    const cmds = (r.data.nextSteps as { command: string }[]).map((s) => s.command);
    expect(cmds).toContain(`mu task delete t -w demo --if ${rev("t")}`);
    expect(opCount()).toBe(ops);
  });

  it("--if <rev> applies; --yes still applies (unchanged)", async () => {
    const r = await runCliJson(
      ["task", "delete", "t", "-w", "demo", "--if", String(rev("t")), "--json"],
      path,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ deleted: true, dryRun: false });
    const y = await runCliJson(["task", "delete", "u", "-w", "demo", "--yes", "--json"], path);
    expect(y.data).toMatchObject({ deleted: true });
  });

  it("a stale --if: exit 4, one line naming the fresh preview, nothing deleted", async () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const ops = opCount();
    const r = await runCli(["task", "delete", "t", "-w", "demo", "--if", String(stale)], path);
    expect(r.exitCode).toBe(4);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain("mu task delete t -w demo");
    expect(opCount()).toBe(ops);
    expect(getTask(db, "t", "demo")).toBeDefined();
  });

  it("stale --if in --json: top-level expected_rev / current_rev, one envelope on stdout", async () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const r = await runCliJson(
      ["task", "delete", "t", "-w", "demo", "--if", String(stale), "--json"],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(r.doc).toMatchObject({
      ok: false,
      error: "RevisionMismatchError",
      exit: 4,
      expected_rev: stale,
      current_rev: rev("t"),
    });
  });

  it("an unknown id stays a no-op (exit 0) even with --if", async () => {
    const r = await runCliJson(
      ["task", "delete", "ghost", "-w", "demo", "--if", "9", "--json"],
      path,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ present: false, deleted: false });
  });

  it("an unknown id returns read-only candidate_ids from the given workstream only", async () => {
    add("demo", "fix_auth");
    add("other", "fix_authz");
    const ops = opCount();
    const r = await runCliJson(
      ["task", "delete", "fix-auth", "-w", "demo", "--yes", "--json"],
      path,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ present: false, candidate_ids: ["fix_auth"] });
    expect(opCount()).toBe(ops);
    expect(getTask(db, "fix_auth", "demo")).toBeDefined();
  });
});

describe("CLI: task block / unblock / reparent", () => {
  it("block --if stale: exit 4, no edge; fresh: one fence for a multi-blocker batch", async () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const r = await runCli(
      ["task", "block", "t", "--by", "u,a_b", "-w", "demo", "--if", String(stale)],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(edgeCount()).toBe(0);
    const ok = await runCliJson(
      ["task", "block", "t", "--by", "u,a_b", "-w", "demo", "--if", String(rev("t")), "--json"],
      path,
    );
    expect(ok.exitCode).toBeNull();
    expect(ok.data).toMatchObject({ addedEdges: 2 });
    expect(edgeCount()).toBe(2);
  });

  it("a failing batch under --if rolls back every edge of it", async () => {
    const r = await runCli(
      ["task", "block", "t", "--by", "u,ghost", "-w", "demo", "--if", String(rev("t"))],
      path,
    );
    expect(r.exitCode).toBe(3);
    expect(edgeCount()).toBe(0);
  });

  it("block without --if keeps today's sequential partial-success", async () => {
    const r = await runCli(["task", "block", "t", "--by", "u,ghost", "-w", "demo"], path);
    expect(r.exitCode).toBe(3);
    expect(edgeCount()).toBe(1);
  });

  it("unblock --if stale: exit 4, edge stays; fresh removes it", async () => {
    addBlockEdge(db, "demo", "t", "u");
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const r = await runCli(
      ["task", "unblock", "t", "--by", "u", "-w", "demo", "--if", String(stale)],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(edgeCount()).toBe(1);
    await runCli(
      ["task", "unblock", "t", "--by", "u", "-w", "demo", "--if", String(rev("t"))],
      path,
    );
    expect(edgeCount()).toBe(0);
  });

  it("unblock of an unknown blocked id is still a no-op under --if", async () => {
    const r = await runCliJson(
      ["task", "unblock", "ghost", "--by", "u", "-w", "demo", "--if", "3", "--json"],
      path,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ removed: false });
  });

  it("reparent --if stale after an edge moved behind the preview: exit 4, edges unchanged", async () => {
    addBlockEdge(db, "demo", "t", "u");
    const stale = rev("t");
    db.prepare("DELETE FROM task_edges").run(); // an edge moved behind our back
    const r = await runCli(
      ["task", "reparent", "t", "--blocked-by", "a_b", "-w", "demo", "--if", String(stale)],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(edgeCount()).toBe(0);
    const ok = await runCli(
      ["task", "reparent", "t", "--blocked-by", "a_b", "-w", "demo", "--if", String(rev("t"))],
      path,
    );
    expect(ok.exitCode).toBeNull();
    expect(getTaskEdges(db, "t", "demo").blockers).toEqual(["a_b"]);
  });
});

describe("CLI: claim / release", () => {
  it("claim --self --if stale: exit 4, unowned; fresh: claimed", async () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const r = await runCli(
      ["task", "claim", "t", "--self", "-w", "demo", "--if", String(stale)],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(getTask(db, "t", "demo")?.status).toBe("OPEN");
    const ok = await runCli(
      ["task", "claim", "t", "--for", "w1", "-w", "demo", "--if", String(rev("t"))],
      path,
    );
    expect(ok.exitCode).toBeNull();
    expect(getTask(db, "t", "demo")?.ownerName).toBe("w1");
  });

  it("release --if stale: exit 4, owner kept", async () => {
    await claimTask(db, "t", { workstream: "demo", agentName: "w1" });
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const r = await runCli(["task", "release", "t", "-w", "demo", "--if", String(stale)], path);
    expect(r.exitCode).toBe(4);
    expect(getTask(db, "t", "demo")?.ownerName).toBe("w1");
  });
});

describe("task show / list expose the revision", () => {
  it("--json show: task.revision; list items carry the same number; human show prints it", async () => {
    addNote(db, "t", "n", { workstream: "demo" });
    const s = await runCliJson(["task", "show", "t", "-w", "demo", "--json"], path);
    expect(s.data.task.revision).toBe(rev("t"));
    const l = await runCliJson(["task", "list", "-w", "demo", "--json"], path);
    const byId = new Map(
      (l.data.items as { name: string; revision: number }[]).map((i) => [i.name, i.revision]),
    );
    expect(byId.get("t")).toBe(rev("t"));
    expect(byId.get("a_b")).toBe(rev("a_b"));
    expect(byId.get("a_b")).not.toBe(byId.get("axb"));
    const h = await runCli(["task", "show", "t", "-w", "demo"], path);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips SGR colour codes
    expect(h.stdout.replace(/\u001b\[[0-9;]*m/g, "")).toContain(`rev        : ${rev("t")}`);
  });
});

describe("candidate_ids: read-only, exact partition", () => {
  beforeEach(() => {
    add("demo", "fix_auth");
    add("other", "fix_auth_other");
  });

  it("a wrong id lists near ids of THAT workstream (never another), exit 3", async () => {
    const r = await runCliJson(["task", "show", "fix-auth", "-w", "demo", "--json"], path);
    expect(r.exitCode).toBe(3);
    expect(r.doc.candidate_ids).toEqual(["fix_auth"]);
    const other = await runCliJson(["task", "show", "fix-auth", "-w", "other", "--json"], path);
    expect(other.doc.candidate_ids).toEqual(["fix_auth_other"]);
  });

  it("a casefolded id is never written through: block refuses and adds nothing", async () => {
    const ops = opCount();
    const r = await runCliJson(
      ["task", "block", "Fix_Auth", "--by", "u", "-w", "demo", "--json"],
      path,
    );
    expect(r.exitCode).toBe(3);
    expect(r.doc.candidate_ids).toEqual(["fix_auth"]);
    expect(opCount()).toBe(ops);
  });

  it("a missing blocker gets candidates from the blocked task's workstream", async () => {
    const r = await runCliJson(
      ["task", "block", "t", "--by", "fixauth", "-w", "demo", "--json"],
      path,
    );
    expect(r.exitCode).toBe(3);
    expect(r.doc.candidate_ids).toEqual(["fix_auth"]);
  });

  it("claim and release name candidates too; no candidates → no key", async () => {
    const c = await runCliJson(
      ["task", "claim", "fix-auth", "--self", "-w", "demo", "--json"],
      path,
    );
    expect(c.doc.candidate_ids).toEqual(["fix_auth"]);
    const rel = await runCliJson(["task", "release", "fix-auth", "-w", "demo", "--json"], path);
    expect(rel.doc.candidate_ids).toEqual(["fix_auth"]);
    const none = await runCliJson(["task", "show", "zzzzzzzz", "-w", "demo", "--json"], path);
    expect(none.exitCode).toBe(3);
    expect("candidate_ids" in none.doc).toBe(false);
  });

  it("human output names the candidates in the next-step hint, as read-only commands", async () => {
    const r = await runCli(["task", "show", "fix-auth", "-w", "demo"], path);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("mu task show fix_auth -w demo");
    expect(r.stderr).not.toMatch(/mu (task (delete|block|close)|sql)/);
  });
});
