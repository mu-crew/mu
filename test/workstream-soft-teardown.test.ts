// k_soft_teardown guarantees, one block each. Fast tier: real SQLite in a
// temp dir, mocked mux, in-process CLI.
//
//   revision    covers ops + agents + worktrees; a sibling name is not in it
//   preview     `teardown <ws>` and `init <torn-down>` write nothing
//   --if        a stale revision exits 4 with one line and changes nothing
//   order       the session dies before any DB change; a late agent aborts the commit
//   soft        one put (torn_down_at) in one group; no tombstones; rows stay
//   invisible   every -w verb says "is torn down" (exit 3); list hides it
//   init reuse  preview, then --if hard-deletes + recreates in ONE group
//   sync        peer puts apply by LWW and still land in a torn-down workstream
//   segments    a soft teardown ships as v2 lines

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { applyOp, type Op } from "../src/apply.js";
import { type Db, openDb, WorkstreamTornDownError } from "../src/db.js";
import { finishDelegate, registerDelegateCall } from "../src/delegates.js";
import { formatHlc } from "../src/hlc.js";
import {
  decodeLine,
  discoverPeers,
  flushSegment,
  ingestSegment,
  localMachineId,
  segmentPath,
} from "../src/segments.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { listTasks } from "../src/tasks.js";
import {
  ensureWorkstream,
  listWorkstreams,
  reinitWorkstream,
  teardownWorkstream,
  WorkstreamRevisionMismatchError,
  workstreamRevision,
} from "../src/workstream.js";
import { registerWorktree } from "../src/worktree.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { asJson, runCli } from "./_runCli.js";
import { softTeardown } from "./_teardown.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness | undefined;

/** A tmux with no sessions (every probe: "can't find session"). */
const noSessions = () =>
  installMux("tmux", [
    ["list-panes", { stdout: "", exitCode: 1, stderr: "can't find session" }],
    ["display-message", { stdout: "", exitCode: 1, stderr: "can't find pane" }],
  ]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-soft-teardown-"));
  process.env.MU_STATE_DIR = dir;
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  mux = noSessions();
});

afterEach(() => {
  mux?.restore();
  mux = undefined;
  try {
    db.close();
  } catch {
    // already closed
  }
  const key = "MU_STATE_DIR";
  delete process.env[key];
  rmFixtureDir(dir);
});

const seed = (ws: string): void => {
  ensureWorkstream(db, ws);
  addTask(db, { workstream: ws, localId: "a", title: "A", impact: 50, effortDays: 1 });
  addTask(db, { workstream: ws, localId: "b", title: "B", impact: 50, effortDays: 1 });
  addNote(db, "a", "n1", { workstream: ws, author: "w" });
};
const opCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
const tornDownAt = (ws: string): string | null =>
  (
    db.prepare("SELECT torn_down_at AS t FROM workstreams WHERE name = ?").get(ws) as {
      t: string | null;
    }
  ).t;
const run = async (...argv: string[]) => {
  db.close();
  const r = await runCli(argv, dbPath);
  db = openDb({ path: dbPath });
  return r;
};

describe("revision", () => {
  it("is 0-seq stable for an unchanged workstream and moves on any op in it", () => {
    seed("ws");
    const r0 = workstreamRevision(db, "ws");
    expect(workstreamRevision(db, "ws")).toBe(r0);
    addNote(db, "a", "n2", { workstream: "ws", author: "w" });
    expect(workstreamRevision(db, "ws")).not.toBe(r0);
  });

  it("ignores ops of a sibling name ('ws-2', 'ws0', 'ws_x')", () => {
    seed("ws");
    const r0 = workstreamRevision(db, "ws");
    for (const sib of ["ws-2", "ws0", "ws_x"]) seed(sib);
    expect(workstreamRevision(db, "ws")).toBe(r0);
  });

  it("covers machine-local state: a new agent or worktree changes it", () => {
    seed("ws");
    const r0 = workstreamRevision(db, "ws");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    const r1 = workstreamRevision(db, "ws");
    expect(r1).not.toBe(r0);
    registerWorktree(db, {
      path: join(dir, "wt"),
      agent: "w1",
      workstream: "ws",
      root: dir,
      base: "abc",
      createdAt: "t",
    });
    expect(workstreamRevision(db, "ws")).not.toBe(r1);
  });

  it("a pane id change on the same agent name changes it", () => {
    seed("ws");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    const r0 = workstreamRevision(db, "ws");
    db.prepare("UPDATE agents SET pane_id = '%2' WHERE name = 'w1'").run();
    expect(workstreamRevision(db, "ws")).not.toBe(r0);
  });

  it("an unknown workstream has a revision (0 ops) and never throws", () => {
    expect(typeof workstreamRevision(db, "ghost")).toBe("number");
  });
});

describe("preview writes nothing", () => {
  it("teardown <ws> prints counts + rev=<n>, exits 0, adds no op and no mux call that changes anything", async () => {
    seed("ws");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    const before = opCount();
    const rev = workstreamRevision(db, "ws");
    const r = await run("workstream", "teardown", "ws");
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain(`rev=${rev}`);
    expect(r.stdout).toContain("tasks");
    expect(r.stdout).toContain(`--if ${rev}`);
    expect(opCount()).toBe(before);
    expect(tornDownAt("ws")).toBeNull();
    expect(mux?.calls.some((c) => c.includes("kill-session"))).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(1);
  });

  it("--json preview carries revision and next is the --if apply", async () => {
    seed("ws");
    const r = await run("workstream", "teardown", "ws", "--json");
    const doc = asJson(r);
    const j = doc.data as { revision: number; dryRun: boolean };
    expect(j.dryRun).toBe(true);
    expect(doc.doc.next).toEqual({
      mode: "alt",
      commands: [`mu workstream teardown ws --if ${j.revision}`],
    });
  });
});

describe("the scratch prune hint", () => {
  it("an applied teardown names `mu delegates prune --older-than 0` only when scratch holds closed delegate tasks", async () => {
    seed("ws");
    const quiet = await run(
      "workstream",
      "teardown",
      "ws",
      "--if",
      String(workstreamRevision(db, "ws")),
    );
    expect(quiet.stdout).not.toContain("delegates prune");
    seed("ws2");
    registerDelegateCall(db, {
      callId: "c1",
      caller: "pi:s",
      workstream: "scratch",
      request: { text: "brief", label: "c1" },
      state: "starting",
    });
    finishDelegate(db, "c1", { outcome: "done", text: "VERDICT: CONFIRMED", author: "d" });
    const r = await run(
      "workstream",
      "teardown",
      "ws2",
      "--if",
      String(workstreamRevision(db, "ws2")),
    );
    expect(r.stdout).toContain(
      "scratch holds 1 closed delegate task(s); teardown never touches scratch. Dry run: mu delegates prune --older-than 0",
    );
  });
});

describe("--if", () => {
  it("refuses a stale revision: exit 4, one line, nothing changed", async () => {
    seed("ws");
    const stale = workstreamRevision(db, "ws");
    addNote(db, "a", "later", { workstream: "ws", author: "w" });
    const now = workstreamRevision(db, "ws");
    const before = opCount();

    const r = await run("workstream", "teardown", "ws", "--if", String(stale));
    expect(r.exitCode).toBe(4);
    const line = `workstream ws changed since preview (rev ${stale} → ${now}); preview again`;
    expect(r.stderr).toContain(line);
    expect(opCount()).toBe(before);
    expect(tornDownAt("ws")).toBeNull();
    expect(mux?.calls.some((c) => c.includes("kill-session"))).toBe(false);
  });

  it("refuses when an agent appeared after the preview, before anything is killed", async () => {
    seed("ws");
    const stale = workstreamRevision(db, "ws");
    insertAgent(db, { name: "late", workstream: "ws", paneId: "%9" });
    await expect(
      teardownWorkstream(db, { workstream: "ws", ifRevision: stale }),
    ).rejects.toBeInstanceOf(WorkstreamRevisionMismatchError);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(1);
    expect(tornDownAt("ws")).toBeNull();
  });

  it("--yes no longer exists (exit 2); nothing happens", async () => {
    seed("ws");
    const r = await run("workstream", "teardown", "ws", "--yes");
    expect(r.exitCode).toBe(2);
    expect(tornDownAt("ws")).toBeNull();
  });

  it("--if rejects a non-integer (exit 2)", async () => {
    seed("ws");
    const r = await run("workstream", "teardown", "ws", "--if", "abc");
    expect(r.exitCode).toBe(2);
  });

  it("applies the previewed revision end to end", async () => {
    seed("ws");
    const rev = workstreamRevision(db, "ws");
    const r = await run("workstream", "teardown", "ws", "--if", String(rev), "--json");
    expect(r.error).toBeUndefined();
    expect(asJson(r).data).toMatchObject({ tornDown: true, tasks: 2, notes: 1 });
    expect(tornDownAt("ws")).not.toBeNull();
  });
});

describe("order: the session dies before any DB change", () => {
  it("a killSession failure leaves the workstream, its agents and its ops untouched", async () => {
    seed("ws");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    mux?.restore();
    mux = installMux("tmux", async (args) => {
      if (args[0] === "list-panes") return { stdout: "@1\t%1\t_mu\n", stderr: "", exitCode: 0 };
      if (args[0] === "kill-session")
        return { stdout: "", stderr: "permission denied", exitCode: 1 };
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    });
    const before = opCount();
    await expect(softTeardown(db, "ws")).rejects.toThrow(/permission denied/);
    expect(opCount()).toBe(before);
    expect(tornDownAt("ws")).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(1);
  });

  it("an agent that appears while the session is being killed aborts the commit", async () => {
    seed("ws");
    const rev = workstreamRevision(db, "ws");
    mux?.restore();
    mux = installMux("tmux", async (args) => {
      if (args[0] === "list-panes") return { stdout: "@1\t%1\t_mu\n", stderr: "", exitCode: 0 };
      if (args[0] === "kill-session") {
        insertAgent(db, { name: "racer", workstream: "ws", paneId: "%7" });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    });
    await expect(
      teardownWorkstream(db, { workstream: "ws", ifRevision: rev }),
    ).rejects.toBeInstanceOf(WorkstreamRevisionMismatchError);
    expect(tornDownAt("ws")).toBeNull();
    // The unseen agent row is NOT deleted by the failed commit.
    expect(db.prepare("SELECT name FROM agents").all()).toEqual([{ name: "racer" }]);
  });
});

describe("--empty sweep revision", () => {
  it("--empty --if refuses (exit 4) when the swept set changed since the preview; nothing is torn down", async () => {
    ensureWorkstream(db, "e1");
    const prev = await run("workstream", "teardown", "--empty", "--json");
    const { revision } = asJson(prev).data as { revision: number };
    ensureWorkstream(db, "e2"); // a new empty workstream appears after the preview
    const r = await run("workstream", "teardown", "--empty", "--if", String(revision));
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/changed since preview/);
    expect(tornDownAt("e1")).toBeNull();
    expect(tornDownAt("e2")).toBeNull();
  });

  it("--empty --if applies the previewed set, each in its own op group", async () => {
    ensureWorkstream(db, "e1");
    ensureWorkstream(db, "e2");
    const prev = await run("workstream", "teardown", "--empty", "--json");
    const { revision } = asJson(prev).data as { revision: number };
    const r = await run("workstream", "teardown", "--empty", "--if", String(revision), "--json");
    expect(asJson(r).data).toMatchObject({ tornDown: 2, failed: [] });
    const groups = db
      .prepare(
        "SELECT DISTINCT group_id FROM ops WHERE intent = 'workstream.teardown' AND entity = 'workstream'",
      )
      .all();
    expect(groups).toHaveLength(2);
  });
});

describe("soft", () => {
  it("writes exactly one workstream put (torn_down_at), no tombstones, one group, intent workstream.teardown", async () => {
    seed("ws");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    const maxSeq = (db.prepare("SELECT MAX(seq) AS s FROM ops").get() as { s: number }).s;
    await softTeardown(db, "ws");
    const ops = db
      .prepare("SELECT entity, op, key, intent, group_id, payload FROM ops WHERE seq > ?")
      .all(maxSeq) as {
      entity: string;
      op: string;
      key: string;
      intent: string;
      group_id: string;
      payload: string;
    }[];
    expect(ops).toHaveLength(1);
    const [o] = ops;
    expect(o).toMatchObject({
      entity: "workstream",
      op: "put",
      key: "ws",
      intent: "workstream.teardown",
    });
    expect(Object.keys(JSON.parse(o?.payload ?? "{}"))).toEqual(["torn_down_at"]);
    expect(ops.filter((x) => x.op === "del")).toEqual([]);
    const count = (t: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([count("tasks"), count("task_notes")]).toEqual([2, 1]);
  });

  it("repeating it does not rewrite torn_down_at", async () => {
    seed("ws");
    await softTeardown(db, "ws");
    const first = tornDownAt("ws");
    await softTeardown(db, "ws");
    expect(tornDownAt("ws")).toBe(first);
  });

  it("finishes the local cleanup of a workstream a peer tore down (agents remain here)", async () => {
    seed("ws");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    db.prepare("UPDATE workstreams SET torn_down_at = '2026-01-01T00:00:00.000Z'").run();
    const rev = workstreamRevision(db, "ws");
    const r = await run("workstream", "teardown", "ws", "--if", String(rev), "--json");
    expect(r.error).toBeUndefined();
    expect(asJson(r).data).toMatchObject({ tornDown: true, deletedAgents: 1 });
    expect(tornDownAt("ws")).toBe("2026-01-01T00:00:00.000Z");
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(0);
  });

  it("an already torn-down workstream with nothing local is a no-op that says so", async () => {
    seed("ws");
    await softTeardown(db, "ws");
    const before = opCount();
    const r = await run("workstream", "teardown", "ws");
    expect(r.error).toBeUndefined();
    expect(r.stdout).toMatch(/already torn down/);
    expect(opCount()).toBe(before);
  });
});

describe("torn-down workstreams are invisible", () => {
  beforeEach(async () => {
    seed("ws");
    seed("live");
    await softTeardown(db, "ws");
  });

  const msg =
    /workstream ws is torn down \(at \d{4}-.*\); `mu workstream init ws` to reuse the name/;

  it.each([
    ["task list", ["task", "list", "-w", "ws"]],
    ["task show", ["task", "show", "a", "-w", "ws"]],
    [
      "task add",
      ["task", "add", "c", "-w", "ws", "--title", "C", "--impact", "5", "--effort-days", "1"],
    ],
    ["task note", ["task", "note", "a", "x", "-w", "ws"]],
    ["task close", ["task", "close", "a", "-w", "ws", "--evidence", "x"]],
    ["state", ["state", "-w", "ws"]],
    ["agent spawn", ["agent", "spawn", "w1", "-w", "ws"]],
  ])("%s -w <torn-down> exits 3 with the one-line message", async (_n, argv) => {
    const r = await run(...argv);
    expect(r.exitCode).toBe(3);
    // `state` fails as its JSON document on stdout; every other verb on stderr.
    expect(
      argv[0] === "state" ? (JSON.parse(r.stdout) as { message: string }).message : r.stderr,
    ).toMatch(msg);
  });

  it("list hides it; the SDK reader throws the typed error", async () => {
    expect((await listWorkstreams(db)).map((w) => w.name)).toEqual(["live"]);
    expect(() => listTasks(db, "ws")).toThrow(WorkstreamTornDownError);
    const r = await run("workstream", "list", "--json");
    expect(JSON.stringify(asJson(r).data)).not.toContain('"name":"ws"');
  });

  it("list --torn-down shows it as soft (rows kept) with the teardown group", async () => {
    const r = await run("workstream", "list", "--torn-down", "--json");
    const items = (asJson(r).data as { items: { name: string; kind: string; group: string }[] })
      .items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "ws", kind: "soft" });
    expect(items[0]?.group).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("list --torn-down also finds a pre-cut-over hard teardown from the log", async () => {
    seed("old");
    db.prepare("DELETE FROM workstreams WHERE name = 'old'").run();
    // A plain DELETE has no intent; stamp the shape the old build wrote.
    db.prepare(
      "UPDATE ops SET intent = 'workstream.teardown' WHERE entity = 'workstream' AND op = 'del' AND key = 'old'",
    ).run();
    const r = await run("workstream", "list", "--torn-down", "--json");
    const items = (asJson(r).data as { items: { name: string; kind: string }[] }).items;
    expect(items.map((i) => [i.name, i.kind]).sort()).toEqual([
      ["old", "hard"],
      ["ws", "soft"],
    ]);
  });
});

describe("init over a torn-down name", () => {
  beforeEach(async () => {
    seed("ws");
    await softTeardown(db, "ws");
  });

  it("without --if prints the preview, exits 0, writes nothing, makes no session", async () => {
    const before = opCount();
    const rev = workstreamRevision(db, "ws");
    const r = await run("workstream", "init", "ws");
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain(
      `will permanently delete torn-down ws: 2 tasks, 1 notes; rev=${rev}`,
    );
    expect(opCount()).toBe(before);
    expect(tornDownAt("ws")).not.toBeNull();
    expect(mux?.calls.some((c) => c.includes("new-session"))).toBe(false);
  });

  it("--if <rev> hard-deletes the old rows and creates the new one in ONE op group (workstream.init)", async () => {
    const rev = workstreamRevision(db, "ws");
    const maxSeq = (db.prepare("SELECT MAX(seq) AS s FROM ops").get() as { s: number }).s;
    mux?.restore();
    mux = installMux("tmux", async (args) => {
      if (args[0] === "list-panes" || args[0] === "has-session")
        return { stdout: "", stderr: "can't find session", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const r = await run("workstream", "init", "ws", "--if", String(rev), "--json");
    expect(r.error).toBeUndefined();
    expect(tornDownAt("ws")).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(0);
    const ops = db
      .prepare("SELECT entity, op, intent, group_id FROM ops WHERE seq > ?")
      .all(maxSeq) as { entity: string; op: string; intent: string; group_id: string }[];
    expect(ops.map((o) => `${o.entity}:${o.op}`)).toEqual(
      expect.arrayContaining(["workstream:del", "task:del", "note:del", "workstream:put"]),
    );
    expect(new Set(ops.map((o) => o.group_id)).size).toBe(1);
    expect(new Set(ops.map((o) => o.intent))).toEqual(new Set(["workstream.init"]));
    expect((await listWorkstreams(db)).map((w) => w.name)).toContain("ws");
  });

  it("--if with a stale revision exits 4 and deletes nothing", async () => {
    const stale = workstreamRevision(db, "ws");
    db.prepare("UPDATE workstreams SET torn_down_at = torn_down_at || ''").run(); // no-op
    addNoteBypassingGuard();
    const r = await run("workstream", "init", "ws", "--if", String(stale));
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/changed since preview/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(2);
  });

  function addNoteBypassingGuard(): void {
    const id = (db.prepare("SELECT id FROM tasks WHERE local_id = 'a'").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, 'p', 'peer', 'now')",
    ).run(id);
  }

  it("refuses (exit 4, deletes nothing) while this machine still has agent rows in the old workstream", async () => {
    // A peer tore "ws" down while this machine kept an agent row in it.
    db.prepare(
      `INSERT INTO agents (workstream_id, name, cli, pane_id, status, role, created_at, updated_at)
       VALUES ((SELECT id FROM workstreams WHERE name = 'ws'), 'w1', 'pi', '%1', 'spawning', 'full-access', 'now', 'now')`,
    ).run();
    const rev = workstreamRevision(db, "ws");
    await expect(reinitWorkstream(db, "ws", rev)).rejects.toThrow(/local agent row/);
    const r = await run("workstream", "init", "ws", "--if", String(rev));
    expect(r.exitCode).toBe(4);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(2);
  });

  it("a live name is idempotent and ignores --if", async () => {
    seed("fresh");
    const before = opCount();
    mux?.restore();
    mux = installMux("tmux", async (args) =>
      args[0] === "list-panes"
        ? { stdout: "@1\t%1\t_mu\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 },
    );
    const r = await run("workstream", "init", "fresh");
    expect(r.error).toBeUndefined();
    expect(opCount()).toBe(before);
  });

  it("scratch: init is allowed only once it is torn down", async () => {
    const plain = await run("workstream", "init", "scratch");
    expect(plain.exitCode).toBe(2);
    ensureWorkstream(db, "scratch");
    await softTeardown(db, "scratch");
    const r = await run("workstream", "init", "scratch");
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("will permanently delete torn-down scratch");
  });
});

describe("sync", () => {
  const PEER = "9f1c8a2e-0000-4000-8000-0000000000aa";
  let n = 0;
  const peerOp = (
    wall: number,
    entity: string,
    key: string,
    payload: Record<string, unknown>,
  ): Op => ({
    hlc: formatHlc({ wallMs: 2_000_000_000_000 + wall, counter: 0, machineId: PEER }),
    machineId: PEER,
    groupId: `g-${++n}`,
    actor: "peer",
    intent: "workstream.teardown",
    entity,
    key,
    op: "put",
    payload: JSON.stringify(payload),
  });

  it("a peer's torn_down_at put hides the workstream here", () => {
    seed("ws");
    applyOp(db, peerOp(1, "workstream", "ws", { torn_down_at: "2026-02-02T00:00:00.000Z" }));
    expect(tornDownAt("ws")).toBe("2026-02-02T00:00:00.000Z");
    expect(() => listTasks(db, "ws")).toThrow(WorkstreamTornDownError);
  });

  it("a peer's later task put into a torn-down workstream applies; views keep hiding it", () => {
    seed("ws");
    db.prepare("UPDATE workstreams SET torn_down_at = 'x'").run();
    expect(() => applyOp(db, peerOp(5, "task", "ws/new", { title: "n" }))).not.toThrow();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks t JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = 'ws' AND t.local_id = 'new'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(() => listTasks(db, "ws")).toThrow(WorkstreamTornDownError);
  });

  it("a soft teardown ships as v2 lines carrying torn_down_at; a peer ingests it and hides the workstream", async () => {
    const sync = join(dir, "sync");
    mkdirSync(sync, { recursive: true });
    seed("ws");
    await softTeardown(db, "ws");
    await flushSegment(db, sync);
    const lines = readFileSync(segmentPath(sync, localMachineId(db)), "utf8")
      .split("\n")
      .filter(Boolean);
    const decoded = lines.map((l) => decodeLine(l));
    expect(decoded.every((d) => d.ok && d.line.v === 2)).toBe(true);
    expect(lines.some((l) => l.includes('"torn_down_at":"'))).toBe(true);

    const other = openDb({ path: join(dir, "peer.db") });
    try {
      const peer = discoverPeers(sync, localMachineId(other))[0];
      if (peer === undefined) throw new Error("expected a peer");
      expect(ingestSegment(other, peer).defects).toEqual([]);
      expect(() => listTasks(other, "ws")).toThrow(WorkstreamTornDownError);
      expect(other.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 });
    } finally {
      other.close();
    }
  });

  it("init --if over a torn-down name converges on a peer (put/del/put)", async () => {
    const sync = join(dir, "sync");
    mkdirSync(sync, { recursive: true });
    seed("ws");
    await softTeardown(db, "ws");
    await reinitWorkstream(db, "ws", workstreamRevision(db, "ws"));
    await flushSegment(db, sync);

    const other = openDb({ path: join(dir, "peer.db") });
    try {
      const peer = discoverPeers(sync, localMachineId(other))[0];
      if (peer === undefined) throw new Error("expected a peer");
      expect(ingestSegment(other, peer).defects).toEqual([]);
      expect(
        other.prepare("SELECT torn_down_at AS t FROM workstreams WHERE name='ws'").get(),
      ).toEqual({ t: null });
      expect(other.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    } finally {
      other.close();
    }
  });
});
